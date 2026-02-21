import { join } from "node:path";
import { Glob } from "bun";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import type { Task } from "../types/index.ts";
import { EntityType } from "../types/index.ts";
import { FileSystem } from "./operations.ts";
import { SqliteCoordinator, type SyncResult } from "./sqlite-coordinator.ts";

/**
 * StorageCoordinator extends FileSystem, adding SQLite-backed ID generation,
 * write serialization, and fast indexing. Core uses this instead of FileSystem directly.
 * Markdown files remain the source of truth; SQLite is the coordination layer.
 */
export class StorageCoordinator extends FileSystem {
	private sqlite: SqliteCoordinator | null = null;
	private syncDone = false;

	/**
	 * Returns the SQLite coordinator, creating it on first access.
	 * The backlog/ directory must exist before calling this.
	 */
	private getSqlite(): SqliteCoordinator {
		if (!this.sqlite) {
			const backlogDir = join(this.rootDir, DEFAULT_DIRECTORIES.BACKLOG);
			this.sqlite = new SqliteCoordinator(backlogDir);
		}
		return this.sqlite;
	}

	/**
	 * Override ensureBacklogStructure to auto-sync SQLite on first run if the index is empty.
	 * Called lazily by Core before any operation. Creates the SQLite coordinator here
	 * (after super creates the backlog/ directory) so the DB file can always be opened.
	 */
	override async ensureBacklogStructure(): Promise<void> {
		await super.ensureBacklogStructure();
		const sqlite = this.getSqlite();
		if (!this.syncDone) {
			this.syncDone = true;
			if (sqlite.isEmpty()) {
				const backlogDir = join(this.rootDir, DEFAULT_DIRECTORIES.BACKLOG);
				await sqlite.sync(backlogDir);
			}
		}
	}

	/**
	 * Generate the next ID atomically via SQLite. No filesystem scan.
	 */
	nextId(entityType: EntityType): string {
		return this.getSqlite().generateNextId(entityType);
	}

	/**
	 * Override saveTask: write markdown first, then update SQLite index.
	 */
	override async saveTask(task: Task): Promise<string> {
		const filePath = await super.saveTask(task);
		const content = await Bun.file(filePath).text();
		this.getSqlite().upsertTask(task, EntityType.Task, filePath, content);
		return filePath;
	}

	/**
	 * Override saveDraft: write markdown first, then update SQLite index.
	 */
	override async saveDraft(task: Task): Promise<string> {
		const filePath = await super.saveDraft(task);
		const content = await Bun.file(filePath).text();
		this.getSqlite().upsertTask(task, EntityType.Draft, filePath, content);
		return filePath;
	}

	/**
	 * Override archiveTask: remove from SQLite index after archiving (archive folder is not indexed).
	 */
	override async archiveTask(taskId: string): Promise<boolean> {
		const result = await super.archiveTask(taskId);
		if (result) {
			this.getSqlite().removeTask(taskId);
		}
		return result;
	}

	/**
	 * Override completeTask: update index to reflect completed entity type.
	 */
	override async completeTask(taskId: string): Promise<boolean> {
		const task = await this.loadTask(taskId);
		const result = await super.completeTask(taskId);
		if (result && task) {
			this.getSqlite().removeTask(taskId);
			const completedDir = join(this.rootDir, DEFAULT_DIRECTORIES.BACKLOG, DEFAULT_DIRECTORIES.COMPLETED);
			const files = await Array.fromAsync(new Glob(`${task.id}*/${task.id}*.md`).scan({ cwd: completedDir }));
			const firstFile = files[0];
			if (firstFile !== undefined) {
				const filePath = join(completedDir, firstFile);
				const content = await Bun.file(filePath).text();
				this.getSqlite().upsertTask(task, "completed", filePath, content);
			}
		}
		return result;
	}

	/**
	 * Full-text search across all tasks using FTS5.
	 * Returns an empty array if SQLite has not been initialized yet or if the query is malformed.
	 */
	searchContent(query: string): Task[] {
		if (!this.sqlite) return [];
		try {
			return this.sqlite.searchTasks(query);
		} catch {
			return [];
		}
	}

	/**
	 * Rebuild SQLite index from all markdown files. Idempotent.
	 */
	async sync(): Promise<SyncResult> {
		const backlogDir = join(this.rootDir, DEFAULT_DIRECTORIES.BACKLOG);
		return this.getSqlite().sync(backlogDir);
	}
}
