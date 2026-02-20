import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { BacklogConfig, Task, TaskListFilter } from "../types/index.ts";
import { buildGlobPattern, extractAnyPrefix, idForFilename, normalizeId } from "../utils/prefix-config.ts";
import { getTaskContainerDir, getTaskFilename, getTaskPath, isSubtaskId, normalizeTaskIdentity } from "../utils/task-path.ts";
import { sortByTaskId } from "../utils/task-sorting.ts";
import { ensureDirectoryExists, sanitizeFilename } from "./shared.ts";

// Interface for task path resolution context
interface TaskPathContext {
	filesystem: {
		tasksDir: string;
	};
}

export class TaskStore {
	private readonly tasksDir: string;
	private readonly completedDir: string;
	private readonly archiveTasksDir: string;
	private readonly loadConfig: () => Promise<BacklogConfig | null>;

	constructor(
		tasksDir: string,
		completedDir: string,
		archiveTasksDir: string,
		loadConfig: () => Promise<BacklogConfig | null>,
	) {
		this.tasksDir = tasksDir;
		this.completedDir = completedDir;
		this.archiveTasksDir = archiveTasksDir;
		this.loadConfig = loadConfig;
	}

	async saveTask(task: Task): Promise<string> {
		// Extract prefix from task ID, or use configured prefix, or fall back to default "task"
		let prefix = extractAnyPrefix(task.id);
		if (!prefix) {
			const config = await this.loadConfig();
			prefix = config?.prefixes?.task ?? "task";
		}
		const taskId = normalizeId(task.id, prefix);
		const filename = `${idForFilename(taskId)} - ${sanitizeFilename(task.title)}.md`;
		const containerDir = getTaskContainerDir(taskId, this.tasksDir);
		const filepath = join(containerDir, filename);
		// Normalize task ID and parentTaskId to uppercase before serialization
		const normalizedTask = {
			...task,
			id: taskId,
			parentTaskId: task.parentTaskId
				? normalizeId(task.parentTaskId, extractAnyPrefix(task.parentTaskId) ?? prefix)
				: undefined,
		};
		const content = serializeTask(normalizedTask);

		// Delete any existing task files with the same ID but different filenames
		try {
			const core = { filesystem: { tasksDir: this.tasksDir } };
			const existingPath = await getTaskPath(taskId, core as TaskPathContext);
			if (existingPath && !existingPath.endsWith(filename)) {
				await unlink(existingPath);
			}
		} catch {
			// Ignore errors if no existing files found
		}

		await ensureDirectoryExists(containerDir);
		await Bun.write(filepath, content);
		return filepath;
	}

	async loadTask(taskId: string): Promise<Task | null> {
		try {
			const core = { filesystem: { tasksDir: this.tasksDir } };
			const filepath = await getTaskPath(taskId, core as TaskPathContext);

			if (!filepath) return null;

			const content = await Bun.file(filepath).text();
			const task = normalizeTaskIdentity(parseTask(content));
			return { ...task, filePath: filepath };
		} catch (_error) {
			return null;
		}
	}

	async listTasks(filter?: TaskListFilter): Promise<Task[]> {
		// Get configured task prefix
		const config = await this.loadConfig();
		const taskPrefix = (config?.prefixes?.task ?? "task").toLowerCase();
		const globPattern = buildGlobPattern(taskPrefix);

		let taskFiles: string[] = [];
		try {
			const topLevel = await Array.fromAsync(
				new Bun.Glob(`*/${globPattern}`).scan({ cwd: this.tasksDir, followSymlinks: true }),
			);
			const subtasks = await Array.fromAsync(
				new Bun.Glob(`*/SubTasks/${globPattern}`).scan({ cwd: this.tasksDir, followSymlinks: true }),
			);
			taskFiles = [...topLevel, ...subtasks];
		} catch {
			return [];
		}

		let tasks: Task[] = [];
		for (const file of taskFiles) {
			const filepath = join(this.tasksDir, file);
			try {
				const content = await Bun.file(filepath).text();
				const task = normalizeTaskIdentity(parseTask(content));
				tasks.push({ ...task, filePath: filepath });
			} catch (error) {
				if (process.env.DEBUG) {
					console.error(`Failed to parse task file ${filepath}`, error);
				}
			}
		}

		if (filter?.status) {
			const statusLower = filter.status.toLowerCase();
			tasks = tasks.filter((t) => t.status.toLowerCase() === statusLower);
		}

		if (filter?.assignee) {
			const assignee = filter.assignee;
			tasks = tasks.filter((t) => t.assignee.includes(assignee));
		}

		return sortByTaskId(tasks);
	}

	async listCompletedTasks(): Promise<Task[]> {
		// Get configured task prefix
		const config = await this.loadConfig();
		const taskPrefix = (config?.prefixes?.task ?? "task").toLowerCase();
		const globPattern = buildGlobPattern(taskPrefix);

		let taskFiles: string[] = [];
		try {
			const topLevel = await Array.fromAsync(
				new Bun.Glob(`*/${globPattern}`).scan({ cwd: this.completedDir, followSymlinks: true }),
			);
			const subtasks = await Array.fromAsync(
				new Bun.Glob(`*/SubTasks/${globPattern}`).scan({ cwd: this.completedDir, followSymlinks: true }),
			);
			taskFiles = [...topLevel, ...subtasks];
		} catch {
			return [];
		}

		const tasks: Task[] = [];
		for (const file of taskFiles) {
			const filepath = join(this.completedDir, file);
			try {
				const content = await Bun.file(filepath).text();
				const task = parseTask(content);
				tasks.push({ ...task, filePath: filepath });
			} catch (error) {
				if (process.env.DEBUG) {
					console.error(`Failed to parse completed task file ${filepath}`, error);
				}
			}
		}

		return sortByTaskId(tasks);
	}

	async listArchivedTasks(): Promise<Task[]> {
		// Get configured task prefix
		const config = await this.loadConfig();
		const taskPrefix = (config?.prefixes?.task ?? "task").toLowerCase();
		const globPattern = buildGlobPattern(taskPrefix);

		let taskFiles: string[] = [];
		try {
			const topLevel = await Array.fromAsync(
				new Bun.Glob(`*/${globPattern}`).scan({ cwd: this.archiveTasksDir, followSymlinks: true }),
			);
			const subtasks = await Array.fromAsync(
				new Bun.Glob(`*/SubTasks/${globPattern}`).scan({ cwd: this.archiveTasksDir, followSymlinks: true }),
			);
			taskFiles = [...topLevel, ...subtasks];
		} catch {
			return [];
		}

		const tasks: Task[] = [];
		for (const file of taskFiles) {
			const filepath = join(this.archiveTasksDir, file);
			try {
				const content = await Bun.file(filepath).text();
				const task = parseTask(content);
				tasks.push({ ...task, filePath: filepath });
			} catch (error) {
				if (process.env.DEBUG) {
					console.error(`Failed to parse archived task file ${filepath}`, error);
				}
			}
		}

		return sortByTaskId(tasks);
	}

	async archiveTask(taskId: string): Promise<boolean> {
		try {
			const prefix = extractAnyPrefix(taskId) ?? "task";
			const normalized = normalizeId(taskId, prefix);

			if (isSubtaskId(normalized)) {
				// Subtask: move just the .md file
				const core = { filesystem: { tasksDir: this.tasksDir } };
				const sourcePath = await getTaskPath(normalized, core as TaskPathContext);
				const relativeFilename = await getTaskFilename(normalized, core as TaskPathContext);
				if (!sourcePath || !relativeFilename) return false;
				const targetPath = join(this.archiveTasksDir, relativeFilename);
				await ensureDirectoryExists(dirname(targetPath));
				await rename(sourcePath, targetPath);
			} else {
				// Top-level task: move entire folder
				const folderName = idForFilename(normalized);
				const sourceFolder = join(this.tasksDir, folderName);
				const targetFolder = join(this.archiveTasksDir, folderName);
				await ensureDirectoryExists(dirname(targetFolder));
				await rename(sourceFolder, targetFolder);
			}
			return true;
		} catch {
			return false;
		}
	}

	async completeTask(taskId: string): Promise<boolean> {
		try {
			const prefix = extractAnyPrefix(taskId) ?? "task";
			const normalized = normalizeId(taskId, prefix);

			if (isSubtaskId(normalized)) {
				// Subtask: move just the .md file
				const core = { filesystem: { tasksDir: this.tasksDir } };
				const sourcePath = await getTaskPath(normalized, core as TaskPathContext);
				const relativeFilename = await getTaskFilename(normalized, core as TaskPathContext);
				if (!sourcePath || !relativeFilename) return false;
				const targetPath = join(this.completedDir, relativeFilename);
				await ensureDirectoryExists(dirname(targetPath));
				await rename(sourcePath, targetPath);
			} else {
				// Top-level task: move entire folder
				const folderName = idForFilename(normalized);
				const sourceFolder = join(this.tasksDir, folderName);
				const targetFolder = join(this.completedDir, folderName);
				await ensureDirectoryExists(dirname(targetFolder));
				await rename(sourceFolder, targetFolder);
			}
			return true;
		} catch {
			return false;
		}
	}
}
