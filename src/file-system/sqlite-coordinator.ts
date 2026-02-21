import type { SQLQueryBindings } from "bun:sqlite";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Glob } from "bun";
import { parseTask } from "../markdown/parser.ts";
import type { Task, TaskListFilter } from "../types/index.ts";
import { EntityType } from "../types/index.ts";

export interface SyncResult {
	tasks: number;
	drafts: number;
	completed: number;
	skipped: Array<{ file: string; reason: string }>;
}

const ENTITY_PREFIXES: Record<string, string> = {
	[EntityType.Task]: "TASK",
	[EntityType.Draft]: "DRAFT",
	[EntityType.Decision]: "DEC",
	[EntityType.Document]: "DOC",
};

export class SqliteCoordinator {
	private readonly db: Database;

	constructor(backlogDir: string) {
		this.db = new Database(join(backlogDir, "llm-backlog.db"));
		this.db.exec("PRAGMA journal_mode = WAL");
		this.db.exec("PRAGMA synchronous = NORMAL");
		this.initSchema();
	}

	private initSchema(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS sequences (
				entity_type TEXT PRIMARY KEY,
				prefix       TEXT NOT NULL,
				current_val  INTEGER NOT NULL DEFAULT 0
			);

			CREATE TABLE IF NOT EXISTS task_index (
				id           TEXT PRIMARY KEY,
				entity_type  TEXT NOT NULL,
				title        TEXT,
				status       TEXT,
				assignee     TEXT,
				labels       TEXT,
				milestone    TEXT,
				priority     TEXT,
				parent_id    TEXT,
				file_path    TEXT NOT NULL,
				body         TEXT,
				updated_date TEXT
			);

			CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5(
				id,
				title,
				body,
				content='task_index',
				content_rowid='rowid'
			);

			CREATE TRIGGER IF NOT EXISTS task_index_ai AFTER INSERT ON task_index BEGIN
				INSERT INTO fts_tasks(rowid, id, title, body) VALUES (new.rowid, new.id, new.title, new.body);
			END;

			CREATE TRIGGER IF NOT EXISTS task_index_ad AFTER DELETE ON task_index BEGIN
				INSERT INTO fts_tasks(fts_tasks, rowid, id, title, body) VALUES ('delete', old.rowid, old.id, old.title, old.body);
			END;

			CREATE TRIGGER IF NOT EXISTS task_index_au AFTER UPDATE ON task_index BEGIN
				INSERT INTO fts_tasks(fts_tasks, rowid, id, title, body) VALUES ('delete', old.rowid, old.id, old.title, old.body);
				INSERT INTO fts_tasks(rowid, id, title, body) VALUES (new.rowid, new.id, new.title, new.body);
			END;
		`);

		for (const [type, prefix] of Object.entries(ENTITY_PREFIXES)) {
			this.db
				.prepare("INSERT OR IGNORE INTO sequences (entity_type, prefix, current_val) VALUES (?, ?, 0)")
				.run(type, prefix);
		}
	}

	/**
	 * Atomically increment and return the next ID for the given entity type.
	 */
	generateNextId(entityType: EntityType): string {
		const getNext = this.db.transaction(() => {
			this.db.prepare("UPDATE sequences SET current_val = current_val + 1 WHERE entity_type = ?").run(entityType);
			const row = this.db
				.prepare<{ current_val: number }, [string]>("SELECT current_val FROM sequences WHERE entity_type = ?")
				.get(entityType);
			if (!row) throw new Error(`Unknown entity type: ${entityType}`);
			return row.current_val;
		});

		const val = getNext();
		const prefix = ENTITY_PREFIXES[entityType] ?? entityType.toUpperCase();
		return `${prefix}-${val}`;
	}

	/**
	 * Insert or replace a task in the index.
	 */
	upsertTask(task: Task, entityType: string, filePath: string, body = ""): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO task_index
				(id, entity_type, title, status, assignee, labels, milestone, priority, parent_id, file_path, body, updated_date)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				task.id,
				entityType,
				task.title ?? null,
				task.status ?? null,
				JSON.stringify(task.assignee ?? []),
				JSON.stringify(task.labels ?? []),
				task.milestone ?? null,
				task.priority ?? null,
				task.parentTaskId ?? null,
				filePath,
				body,
				task.updatedDate ?? null,
			);
	}

	/**
	 * Remove a task from the index.
	 */
	removeTask(id: string): void {
		this.db.prepare("DELETE FROM task_index WHERE id = ?").run(id);
	}

	/**
	 * Query the index without scanning the filesystem.
	 */
	queryTasks(entityType: string, filter?: TaskListFilter): Task[] {
		const conditions: string[] = ["entity_type = ?"];
		const params: SQLQueryBindings[] = [entityType];

		if (filter?.status) {
			conditions.push("status = ?");
			params.push(filter.status);
		}
		if (filter?.assignee) {
			conditions.push("assignee LIKE ?");
			params.push(`%${filter.assignee}%`);
		}
		if (filter?.parentTaskId) {
			conditions.push("parent_id = ?");
			params.push(filter.parentTaskId);
		}

		const rows = this.db
			.prepare<Record<string, unknown>, SQLQueryBindings[]>(
				`SELECT id, entity_type, title, status, assignee, labels, milestone, priority, parent_id, updated_date, file_path
				 FROM task_index WHERE ${conditions.join(" AND ")} ORDER BY id`,
			)
			.all(...params);

		return rows.map((row) => this.rowToTask(row));
	}

	/**
	 * Full-text search using FTS5.
	 */
	searchTasks(query: string): Task[] {
		const rows = this.db
			.prepare<Record<string, unknown>, [string]>(
				`SELECT t.id, t.entity_type, t.title, t.status, t.assignee, t.labels,
				        t.milestone, t.priority, t.parent_id, t.updated_date, t.file_path
				 FROM task_index t
				 JOIN fts_tasks fts ON fts.id = t.id
				 WHERE fts MATCH ?
				 ORDER BY rank`,
			)
			.all(query);

		return rows.map((row) => this.rowToTask(row));
	}

	/**
	 * Returns true if the task_index is empty (db was just created).
	 */
	isEmpty(): boolean {
		const row = this.db.prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM task_index").get();
		return (row?.count ?? 0) === 0;
	}

	/**
	 * Rebuild the entire index from markdown files. Idempotent.
	 */
	async sync(backlogDir: string): Promise<SyncResult> {
		const result: SyncResult = { tasks: 0, drafts: 0, completed: 0, skipped: [] };

		const filesToProcess: Array<{ filePath: string; entityType: string; counter: keyof SyncResult }> = [];

		const patterns: Array<{ glob: string; entityType: string; counter: "tasks" | "drafts" | "completed" }> = [
			{ glob: "tasks/**/*.md", entityType: EntityType.Task, counter: "tasks" },
			{ glob: "drafts/**/*.md", entityType: EntityType.Draft, counter: "drafts" },
			{ glob: "completed/**/*.md", entityType: "completed", counter: "completed" },
		];

		for (const { glob: pattern, entityType, counter } of patterns) {
			const globber = new Glob(pattern);
			for await (const file of globber.scan({ cwd: backlogDir })) {
				filesToProcess.push({ filePath: join(backlogDir, file), entityType, counter });
			}
		}

		const fileContents = await Promise.all(
			filesToProcess.map(async (f) => ({ ...f, content: await Bun.file(f.filePath).text() })),
		);

		const populate = this.db.transaction(() => {
			this.db.exec("DELETE FROM task_index");
			for (const { filePath, entityType, counter, content } of fileContents) {
				try {
					const task = parseTask(content);
					const body = task.rawContent ?? "";
					this.upsertTask(task, entityType, filePath, body);
					result[counter]++;
				} catch (err) {
					result.skipped.push({
						file: filePath,
						reason: err instanceof Error ? err.message : String(err),
					});
				}
			}
		});

		populate();
		this.recalculateSequences();
		return result;
	}

	recalculateSequences(): void {
		for (const entityType of Object.keys(ENTITY_PREFIXES)) {
			const prefix = ENTITY_PREFIXES[entityType] ?? entityType.toUpperCase();
			const row = this.db
				.prepare<{ max_val: number | null }, [string, string, string]>(
					`SELECT MAX(CAST(REPLACE(LOWER(id), LOWER(? || '-'), '') AS INTEGER)) as max_val
					 FROM task_index WHERE entity_type = ? AND id LIKE ? || '-%'`,
				)
				.get(prefix, entityType, prefix);

			if (row?.max_val != null) {
				this.db.prepare("UPDATE sequences SET current_val = ? WHERE entity_type = ?").run(row.max_val, entityType);
			}
		}
	}

	private rowToTask(row: Record<string, unknown>): Task {
		return {
			id: row.id as string,
			title: (row.title as string) ?? "",
			status: (row.status as string) ?? "",
			assignee: JSON.parse((row.assignee as string) ?? "[]"),
			labels: JSON.parse((row.labels as string) ?? "[]"),
			milestone: (row.milestone as string) ?? undefined,
			priority: (row.priority as string) ?? undefined,
			parentTaskId: (row.parent_id as string) ?? undefined,
			updatedDate: (row.updated_date as string) ?? undefined,
			dependencies: [],
			createdDate: "",
		} as unknown as Task;
	}

	close(): void {
		this.db.close();
	}
}
