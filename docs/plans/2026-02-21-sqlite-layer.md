# SQLite Coordination Layer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a SQLite layer on top of the existing filesystem that provides atomic ID generation, serialized writes, and fast indexing — without changing how markdown files work.

**Architecture:** `StorageCoordinator extends FileSystem` and owns a `SqliteCoordinator`. `Core` constructs a `StorageCoordinator` instead of `FileSystem`. All existing code using `this.fs` works unchanged since `StorageCoordinator` is a `FileSystem`.

**Tech Stack:** Bun native SQLite (`bun:sqlite`), FTS5 virtual tables, WAL mode.

---

### Task 1: Gitignore the database file

**Files:**
- Modify: `.gitignore`

**Step 1: Add db pattern**

Open `.gitignore` and add at the end:
```
# SQLite coordination database
backlog/llm-backlog.db
backlog/llm-backlog.db-wal
backlog/llm-backlog.db-shm
```

**Step 2: Commit**
```bash
git add .gitignore
git commit -m "chore: ignore SQLite coordination database files"
```

---

### Task 2: Create `SqliteCoordinator`

**Files:**
- Create: `src/file-system/sqlite-coordinator.ts`

This class owns the SQLite connection. All its methods are synchronous (Bun SQLite is sync), except `sync()` which reads markdown files.

**Step 1: Write the file**

```typescript
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { Glob } from "bun";
import { deserializeTask } from "../markdown/serializer.ts";
import type { Task, TaskListFilter } from "../types/index.ts";
import { EntityType } from "../types/index.ts";

export interface SyncResult {
	tasks: number;
	drafts: number;
	completed: number;
}

const ENTITY_PREFIXES: Record<string, string> = {
	[EntityType.Task]: "TASK",
	[EntityType.Draft]: "DRAFT",
	[EntityType.Decision]: "DEC",
	[EntityType.Document]: "DOC",
};

export class SqliteCoordinator {
	private readonly db: Database;
	private readonly backlogDir: string;

	constructor(backlogDir: string) {
		this.backlogDir = backlogDir;
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

		// Seed sequence rows if missing
		for (const [type, prefix] of Object.entries(ENTITY_PREFIXES)) {
			this.db
				.prepare("INSERT OR IGNORE INTO sequences (entity_type, prefix, current_val) VALUES (?, ?, 0)")
				.run(type, prefix);
		}
	}

	/**
	 * Atomically increment and return the next ID for the given entity type.
	 * Uses BEGIN IMMEDIATE to serialize concurrent writers.
	 */
	generateNextId(entityType: EntityType): string {
		const getNext = this.db.transaction(() => {
			this.db
				.prepare("UPDATE sequences SET current_val = current_val + 1 WHERE entity_type = ?")
				.run(entityType);
			const row = this.db
				.prepare<{ current_val: number }, [string]>(
					"SELECT current_val FROM sequences WHERE entity_type = ?",
				)
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
	 * Called after every markdown write to keep SQLite in sync.
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
	 * Remove a task from the index (called on archive/complete before re-inserting under new entity_type).
	 */
	removeTask(id: string): void {
		this.db.prepare("DELETE FROM task_index WHERE id = ?").run(id);
	}

	/**
	 * Query the index. Returns tasks matching the filter without scanning the filesystem.
	 */
	queryTasks(entityType: string, filter?: TaskListFilter): Task[] {
		const conditions: string[] = ["entity_type = ?"];
		const params: unknown[] = [entityType];

		if (filter?.status) {
			conditions.push("status = ?");
			params.push(filter.status);
		}
		if (filter?.assignee) {
			conditions.push("assignee LIKE ?");
			params.push(`%${filter.assignee}%`);
		}
		if (filter?.milestone) {
			conditions.push("milestone = ?");
			params.push(filter.milestone);
		}

		const rows = this.db
			.prepare<Record<string, unknown>, unknown[]>(
				`SELECT id, entity_type, title, status, assignee, labels, milestone, priority, parent_id, updated_date, file_path
				 FROM task_index WHERE ${conditions.join(" AND ")} ORDER BY id`,
			)
			.all(...params);

		return rows.map((row) => this.rowToTask(row));
	}

	/**
	 * Full-text search over task titles and bodies using FTS5.
	 */
	searchTasks(query: string): Task[] {
		const rows = this.db
			.prepare<Record<string, unknown>, [string]>(
				`SELECT t.id, t.entity_type, t.title, t.status, t.assignee, t.labels,
				        t.milestone, t.priority, t.parent_id, t.updated_date, t.file_path
				 FROM task_index t
				 JOIN fts_tasks fts ON fts.id = t.id
				 WHERE fts_tasks MATCH ?
				 ORDER BY rank`,
			)
			.all(query);

		return rows.map((row) => this.rowToTask(row));
	}

	/**
	 * Returns true if the task_index is empty (db was just created).
	 */
	isEmpty(): boolean {
		const row = this.db
			.prepare<{ count: number }, []>("SELECT COUNT(*) as count FROM task_index")
			.get();
		return (row?.count ?? 0) === 0;
	}

	/**
	 * Rebuild the entire index from markdown files on disk.
	 * Idempotent — can be run any number of times.
	 */
	async sync(backlogDir: string): Promise<SyncResult> {
		const result: SyncResult = { tasks: 0, drafts: 0, completed: 0 };

		const clearAndRepopulate = this.db.transaction(async () => {
			this.db.exec("DELETE FROM task_index");

			const patterns: Array<{ glob: string; entityType: string; counter: keyof SyncResult }> = [
				{ glob: "tasks/**/*.md", entityType: EntityType.Task, counter: "tasks" },
				{ glob: "drafts/**/*.md", entityType: EntityType.Draft, counter: "drafts" },
				{ glob: "completed/**/*.md", entityType: "completed", counter: "completed" },
			];

			for (const { glob: pattern, entityType, counter } of patterns) {
				const globber = new Glob(pattern);
				for await (const file of globber.scan({ cwd: backlogDir })) {
					const filePath = join(backlogDir, file);
					const content = await Bun.file(filePath).text();
					try {
						const task = deserializeTask(content, filePath);
						if (task?.id) {
							this.upsertTask(task, entityType, filePath, content);
							result[counter]++;
						}
					} catch {
						// Skip malformed files
					}
				}
			}
		});

		await clearAndRepopulate();
		this.recalculateSequences();
		return result;
	}

	/**
	 * Recalculate sequence current_val from the max numeric ID in the index.
	 * Called after sync to ensure generateNextId() returns correct values.
	 */
	private recalculateSequences(): void {
		for (const entityType of Object.keys(ENTITY_PREFIXES)) {
			const prefix = ENTITY_PREFIXES[entityType];
			const row = this.db
				.prepare<{ max_val: number | null }, [string, string]>(
					`SELECT MAX(CAST(REPLACE(id, ? || '-', '') AS INTEGER)) as max_val
					 FROM task_index WHERE entity_type = ? AND id LIKE ? || '-%'`,
				)
				.get(prefix, entityType, prefix);

			if (row?.max_val != null) {
				this.db
					.prepare("UPDATE sequences SET current_val = ? WHERE entity_type = ? AND current_val < ?")
					.run(row.max_val, entityType, row.max_val);
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
```

**Step 2: Run type-check**
```bash
bunx tsc --noEmit 2>&1 | head -30
```
Expected: zero errors (or only pre-existing unrelated errors).

**Step 3: Commit**
```bash
git add src/file-system/sqlite-coordinator.ts
git commit -m "feat: add SqliteCoordinator for atomic ID generation and task indexing"
```

---

### Task 3: Create `StorageCoordinator`

**Files:**
- Create: `src/file-system/storage-coordinator.ts`

`StorageCoordinator extends FileSystem`. It overrides the key write/list methods to keep SQLite in sync. It also overrides `ensureBacklogStructure()` to auto-sync on first run.

**Step 1: Check the exact signature of `deserializeTask` or equivalent**

Look at how markdown files are parsed in `src/markdown/`:
```bash
grep -n "export.*deserialize\|export.*parse\|export.*fromMarkdown" src/markdown/*.ts
```

You need to know the function name and import path that parses a markdown file string into a `Task`.

**Step 2: Write the file**

```typescript
import { join } from "node:path";
import type { Task, TaskListFilter } from "../types/index.ts";
import { EntityType } from "../types/index.ts";
import { FileSystem } from "./operations.ts";
import { SqliteCoordinator, type SyncResult } from "./sqlite-coordinator.ts";

/**
 * StorageCoordinator extends FileSystem, adding SQLite-backed ID generation,
 * write serialization, and fast indexing. Core uses this instead of FileSystem directly.
 */
export class StorageCoordinator extends FileSystem {
	private readonly sqlite: SqliteCoordinator;
	private syncDone = false;

	constructor(projectRoot: string) {
		super(projectRoot);
		const backlogDir = join(projectRoot, "backlog");
		this.sqlite = new SqliteCoordinator(backlogDir);
	}

	/**
	 * Override ensureBacklogStructure to auto-sync SQLite on first run.
	 * Called lazily by Core before any operation.
	 */
	override async ensureBacklogStructure(): Promise<void> {
		await super.ensureBacklogStructure();
		if (!this.syncDone) {
			this.syncDone = true;
			if (this.sqlite.isEmpty()) {
				const backlogDir = join(this.rootDir, "backlog");
				await this.sqlite.sync(backlogDir);
			}
		}
	}

	/**
	 * Generate the next ID atomically via SQLite. No filesystem scan.
	 */
	nextId(entityType: EntityType): string {
		return this.sqlite.generateNextId(entityType);
	}

	/**
	 * Override saveTask: write markdown first, then update index.
	 */
	override async saveTask(task: Task): Promise<string> {
		const filePath = await super.saveTask(task);
		const content = await Bun.file(filePath).text();
		this.sqlite.upsertTask(task, EntityType.Task, filePath, content);
		return filePath;
	}

	/**
	 * Override saveDraft: write markdown first, then update index.
	 */
	override async saveDraft(task: Task): Promise<string> {
		const filePath = await super.saveDraft(task);
		const content = await Bun.file(filePath).text();
		this.sqlite.upsertTask(task, EntityType.Draft, filePath, content);
		return filePath;
	}

	/**
	 * Override listTasks: query SQLite index instead of scanning the filesystem.
	 */
	override async listTasks(filter?: TaskListFilter): Promise<Task[]> {
		return this.sqlite.queryTasks(EntityType.Task, filter);
	}

	/**
	 * Override listCompletedTasks: query SQLite index.
	 */
	override async listCompletedTasks(): Promise<Task[]> {
		return this.sqlite.queryTasks("completed");
	}

	/**
	 * Override listDrafts: query SQLite index.
	 */
	override async listDrafts(): Promise<Task[]> {
		return this.sqlite.queryTasks(EntityType.Draft);
	}

	/**
	 * Override archiveTask: remove from index (archive folder is not indexed).
	 */
	override async archiveTask(taskId: string): Promise<boolean> {
		const result = await super.archiveTask(taskId);
		if (result) {
			this.sqlite.removeTask(taskId);
		}
		return result;
	}

	/**
	 * Override completeTask: move task to completed entity_type in the index.
	 */
	override async completeTask(taskId: string): Promise<boolean> {
		const task = await this.loadTask(taskId);
		const result = await super.completeTask(taskId);
		if (result && task) {
			this.sqlite.removeTask(taskId);
			// Re-index under 'completed' entity type
			const completedDir = join(this.rootDir, "backlog", "completed");
			const files = await Array.fromAsync(
				new Bun.Glob(`${task.id}*/${task.id}*.md`).scan({ cwd: completedDir }),
			);
			if (files.length > 0) {
				const filePath = join(completedDir, files[0]);
				const content = await Bun.file(filePath).text();
				this.sqlite.upsertTask(task, "completed", filePath, content);
			}
		}
		return result;
	}

	/**
	 * Full-text search across all tasks using FTS5.
	 */
	searchContent(query: string): Task[] {
		return this.sqlite.searchTasks(query);
	}

	/**
	 * Rebuild SQLite index from all markdown files. Idempotent.
	 */
	async sync(): Promise<SyncResult> {
		const backlogDir = join(this.rootDir, "backlog");
		return this.sqlite.sync(backlogDir);
	}
}
```

**Step 3: Run type-check**
```bash
bunx tsc --noEmit 2>&1 | head -30
```

**Step 4: Commit**
```bash
git add src/file-system/storage-coordinator.ts
git commit -m "feat: add StorageCoordinator facade over FileSystem and SqliteCoordinator"
```

---

### Task 4: Wire `Core` to use `StorageCoordinator`

**Files:**
- Modify: `src/core/backlog.ts`

Two changes:
1. Default to `StorageCoordinator` instead of `FileSystem`
2. `generateNextId` uses SQLite when `StorageCoordinator` is available

**Step 1: Read the relevant section of `backlog.ts`**

Read lines 1–130 of `src/core/backlog.ts` to see imports and constructor.

**Step 2: Add import for `StorageCoordinator`**

Find the import of `FileSystem`:
```typescript
import { FileSystem } from "../file-system/operations.ts";
```

Add below it:
```typescript
import { StorageCoordinator } from "../file-system/storage-coordinator.ts";
```

**Step 3: Change the default filesystem construction (line ~118)**

Find:
```typescript
this.fs = options?.filesystem ?? new FileSystem(projectRoot);
```

Replace with:
```typescript
this.fs = options?.filesystem ?? new StorageCoordinator(projectRoot);
```

**Step 4: Update `generateNextId` to use SQLite (line ~287)**

Find:
```typescript
async generateNextId(type: EntityType = EntityType.Task, parent?: string): Promise<string> {
    return generateNextId(this, type, parent);
}
```

Replace with:
```typescript
async generateNextId(type: EntityType = EntityType.Task, parent?: string): Promise<string> {
    if (this.fs instanceof StorageCoordinator && type !== EntityType.Document) {
        return this.fs.nextId(type);
    }
    return generateNextId(this, type, parent);
}
```

Note: `EntityType.Document` uses its own ID scheme via `generateNextDocId` — leave that untouched.

**Step 5: Run type-check**
```bash
bunx tsc --noEmit 2>&1 | head -30
```

**Step 6: Run tests to check nothing broke**
```bash
CLAUDECODE=1 bun test 2>&1 | tail -20
```

**Step 7: Commit**
```bash
git add src/core/backlog.ts
git commit -m "feat: wire Core to use StorageCoordinator by default"
```

---

### Task 5: Add `backlog_sync` MCP tool

**Files:**
- Create: `src/mcp/tools/workflow/sync-tool.ts`
- Modify: `src/mcp/tools/workflow/index.ts`

**Step 1: Read `src/mcp/tools/tasks/index.ts`**

Read it to understand how other tools are structured — specifically `createSimpleValidatedTool` usage.

**Step 2: Write `sync-tool.ts`**

```typescript
import { StorageCoordinator } from "../../../file-system/storage-coordinator.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";

const emptyInputSchema: JsonSchema = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
};

export function createSyncTool(server: McpServer): McpToolHandler {
	return createSimpleValidatedTool(
		{
			name: "backlog_sync",
			description:
				"Rebuild the SQLite index from all markdown files in the backlog directory. " +
				"Run this after manually editing markdown files outside the tool, or after a git pull.",
			inputSchema: emptyInputSchema,
		},
		emptyInputSchema,
		async () => {
			if (!(server.fs instanceof StorageCoordinator)) {
				return {
					content: [
						{
							type: "text",
							text: "SQLite coordination layer is not active. No sync needed.",
						},
					],
				};
			}

			const result = await server.fs.sync();
			const text =
				`Sync complete.\n` +
				`  Tasks:     ${result.tasks}\n` +
				`  Drafts:    ${result.drafts}\n` +
				`  Completed: ${result.completed}`;

			return {
				content: [{ type: "text", text }],
			};
		},
	);
}
```

**Step 3: Register in `index.ts`**

Read `src/mcp/tools/workflow/index.ts` and find `registerWorkflowTools`. Add the sync tool registration:

```typescript
import { createSyncTool } from "./sync-tool.ts";

export function registerWorkflowTools(server: McpServer): void {
	for (const guide of WORKFLOW_GUIDES) {
		server.addTool(createWorkflowTool(server, guide));
	}
	server.addTool(createSyncTool(server)); // add this line
}
```

**Step 4: Run type-check**
```bash
bunx tsc --noEmit 2>&1 | head -30
```

**Step 5: Commit**
```bash
git add src/mcp/tools/workflow/sync-tool.ts src/mcp/tools/workflow/index.ts
git commit -m "feat: add backlog_sync MCP tool to rebuild SQLite index"
```

---

### Task 6: Integration tests

**Files:**
- Modify: `src/test/integration.test.ts`

**Step 1: Read the end of integration.test.ts**

Read the last 100 lines to understand where to add new test groups and the `mcpCall` helper pattern.

**Step 2: Add a new test group at the end**

```typescript
describe("SQLite coordination layer", () => {
	let env: TestEnv;

	beforeAll(async () => {
		const configDir = uniqueDir("cfg-repo");
		const projectDir = uniqueDir("proj-repo");
		await buildConfigRepo(configDir);
		await buildProjectRepo(projectDir);
		process.env.AUTH_CONFIG_REPO = configDir;
		const server = new BacklogServer(projectDir);
		const port = 7800 + Math.floor(Math.random() * 100);
		await server.start(port, false);
		env = { server, baseUrl: `http://localhost:${port}`, projectDir, configDir };
	});

	afterAll(async () => {
		await env.server.stop();
		await cleanup(env.projectDir, env.configDir);
		delete process.env.AUTH_CONFIG_REPO;
	});

	async function mcpCall(body: unknown): Promise<Response> {
		return fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ADMIN_API_KEY}`,
			},
			body: JSON.stringify(body),
		});
	}

	test("backlog_sync tool returns sync counts", async () => {
		const res = await mcpCall({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "backlog_sync", arguments: {} },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { result: { content: Array<{ text: string }> } };
		const text = body.result.content[0].text;
		expect(text).toContain("Sync complete");
		expect(text).toContain("Tasks:");
	});

	test("sequential task creates produce unique IDs", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const res = await mcpCall({
				jsonrpc: "2.0",
				id: i + 10,
				method: "tools/call",
				params: {
					name: "task_create",
					arguments: { title: `Concurrent task ${i}`, status: "todo" },
				},
			});
			expect(res.status).toBe(200);
			const body = await res.json() as { result: { content: Array<{ text: string }> } };
			const match = body.result.content[0].text.match(/[A-Z]+-\d+/);
			if (match) ids.push(match[0]);
		}
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	test("task_list returns tasks from SQLite index", async () => {
		const res = await mcpCall({
			jsonrpc: "2.0",
			id: 20,
			method: "tools/call",
			params: { name: "task_list", arguments: {} },
		});
		expect(res.status).toBe(200);
		const body = await res.json() as { result: { content: Array<{ text: string }> } };
		expect(body.result.content[0].text.length).toBeGreaterThan(0);
	});
});
```

**Step 3: Run the new tests**
```bash
CLAUDECODE=1 bun test src/test/integration.test.ts 2>&1 | tail -30
```
Expected: the 3 new tests pass.

**Step 4: Run full test suite**
```bash
CLAUDECODE=1 bun test 2>&1 | tail -20
```
Expected: all tests pass.

**Step 5: Commit**
```bash
git add src/test/integration.test.ts
git commit -m "test: add integration tests for SQLite coordination layer"
```

---

## Verification Checklist

Before declaring done:
- [ ] `bunx tsc --noEmit` — zero errors
- [ ] `bun run check .` — zero lint warnings
- [ ] `CLAUDECODE=1 bun test` — all tests pass
- [ ] `backlog/llm-backlog.db` appears in `.gitignore`
- [ ] Creating a task via MCP returns a unique ID
- [ ] Calling `backlog_sync` returns task/draft/completed counts
