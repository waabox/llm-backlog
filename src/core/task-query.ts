import { DEFAULT_DIRECTORIES, DEFAULT_STATUSES } from "../constants/index.ts";
import type { SearchFilters, Task, TaskListFilter } from "../types/index.ts";
import { getTaskPath, normalizeTaskId, taskIdsEqual } from "../utils/task-path.ts";
import { attachSubtaskSummaries } from "../utils/task-subtasks.ts";
import type { Core } from "./backlog.ts";
import {
	type BranchTaskStateEntry,
	findTaskInLocalBranches,
	findTaskInRemoteBranches,
	getTaskLoadingMessage,
	loadLocalBranchTasks,
	loadRemoteTasks,
	resolveTaskConflict,
} from "./task-loader.ts";
import { applyTaskFilters, filterLocalEditableTasks } from "./task-mutation.ts";

export interface TaskQueryOptions {
	filters?: TaskListFilter;
	query?: string;
	limit?: number;
	includeCrossBranch?: boolean;
}

export function buildLatestStateMap(
	stateEntries: BranchTaskStateEntry[] = [],
	localTasks: Array<Task & { lastModified?: Date; updatedDate?: string }> = [],
): Map<string, BranchTaskStateEntry> {
	const latest = new Map<string, BranchTaskStateEntry>();
	const update = (entry: BranchTaskStateEntry) => {
		const existing = latest.get(entry.id);
		if (!existing || entry.lastModified > existing.lastModified) {
			latest.set(entry.id, entry);
		}
	};

	for (const entry of stateEntries) {
		update(entry);
	}

	for (const task of localTasks) {
		if (!task.id) continue;
		const lastModified = task.lastModified ?? (task.updatedDate ? new Date(task.updatedDate) : new Date(0));

		update({
			id: task.id,
			type: "task",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	return latest;
}

export function filterTasksByStateSnapshots(tasks: Task[], latestState: Map<string, BranchTaskStateEntry>): Task[] {
	return tasks.filter((task) => {
		const latest = latestState.get(task.id);
		if (!latest) return true;
		return latest.type === "task";
	});
}

/**
 * Extract IDs from state map where latest state is "task" or "completed" (not "archived" or "draft")
 * Used for ID generation to determine which IDs are in use.
 */
export function getActiveAndCompletedIdsFromStateMap(latestState: Map<string, BranchTaskStateEntry>): string[] {
	const ids: string[] = [];
	for (const [id, entry] of latestState) {
		if (entry.type === "task" || entry.type === "completed") {
			ids.push(id);
		}
	}
	return ids;
}

export async function queryTasks(core: Core, options: TaskQueryOptions = {}): Promise<Task[]> {
	const { filters, query, limit } = options;
	const trimmedQuery = query?.trim();
	const includeCrossBranch = options.includeCrossBranch ?? true;

	const applyFiltersAndLimit = (collection: Task[]): Task[] => {
		let filtered = applyTaskFilters(collection, filters);
		if (!includeCrossBranch) {
			filtered = filterLocalEditableTasks(filtered);
		}
		if (typeof limit === "number" && limit >= 0) {
			return filtered.slice(0, limit);
		}
		return filtered;
	};

	if (!trimmedQuery) {
		const store = await core.getContentStore();
		const tasks = store.getTasks();
		return applyFiltersAndLimit(tasks);
	}

	const searchService = await core.getSearchService();
	const searchFilters: SearchFilters = {};
	if (filters?.status) {
		searchFilters.status = filters.status;
	}
	if (filters?.priority) {
		searchFilters.priority = filters.priority;
	}
	if (filters?.assignee) {
		searchFilters.assignee = filters.assignee;
	}
	if (filters?.labels) {
		searchFilters.labels = filters.labels;
	}

	const searchResults = searchService.search({
		query: trimmedQuery,
		limit,
		types: ["task"],
		filters: Object.keys(searchFilters).length > 0 ? searchFilters : undefined,
	});

	const seen = new Set<string>();
	const tasks: Task[] = [];
	for (const result of searchResults) {
		if (result.type !== "task") continue;
		const task = result.task;
		if (seen.has(task.id)) continue;
		seen.add(task.id);
		tasks.push(task);
	}

	return applyFiltersAndLimit(tasks);
}

export async function getTask(core: Core, taskId: string): Promise<Task | null> {
	const store = await core.getContentStore();
	const tasks = store.getTasks();
	const match = tasks.find((task) => taskIdsEqual(taskId, task.id));
	if (match) {
		return match;
	}

	// Pass raw ID to loadTask - it will handle prefix detection via getTaskPath
	return await core.fs.loadTask(taskId);
}

export async function getTaskWithSubtasks(core: Core, taskId: string, localTasks?: Task[]): Promise<Task | null> {
	const task = await loadTaskById(core, taskId);
	if (!task) {
		return null;
	}

	const tasks = localTasks ?? (await core.fs.listTasks());
	return attachSubtaskSummaries(task, tasks);
}

export async function loadTaskById(core: Core, taskId: string): Promise<Task | null> {
	// Pass raw ID to loadTask - it will handle prefix detection via getTaskPath
	const localTask = await core.fs.loadTask(taskId);
	if (localTask) return localTask;

	// Check config for remote operations
	const config = await core.fs.loadConfig();
	const sinceDays = config?.activeBranchDays ?? 30;
	const taskPrefix = config?.prefixes?.task ?? "task";

	// For cross-branch search, normalize with configured prefix
	const canonicalId = normalizeTaskId(taskId, taskPrefix);

	// Try other local branches first (faster than remote)
	const localBranchTask = await findTaskInLocalBranches(
		core.git,
		canonicalId,
		DEFAULT_DIRECTORIES.BACKLOG,
		sinceDays,
		taskPrefix,
	);
	if (localBranchTask) return localBranchTask;

	// Skip remote if disabled
	if (config?.remoteOperations === false) return null;

	// Try remote branches
	return await findTaskInRemoteBranches(core.git, canonicalId, DEFAULT_DIRECTORIES.BACKLOG, sinceDays, taskPrefix);
}

export async function getTaskContent(core: Core, taskId: string): Promise<string | null> {
	const filePath = await getTaskPath(taskId, core);
	if (!filePath) return null;
	return await Bun.file(filePath).text();
}

export async function listTasksWithMetadata(
	core: Core,
	includeBranchMeta = false,
): Promise<Array<Task & { lastModified?: Date; branch?: string }>> {
	const tasks = await core.fs.listTasks();
	return await Promise.all(
		tasks.map(async (task) => {
			const filePath = await getTaskPath(task.id, core);

			if (filePath) {
				const bunFile = Bun.file(filePath);
				const stats = await bunFile.stat();
				return {
					...task,
					lastModified: new Date(stats.mtime),
					// Only include branch if explicitly requested
					...(includeBranchMeta && {
						branch: (await core.git.getFileLastModifiedBranch(filePath)) || undefined,
					}),
				};
			}
			return task;
		}),
	);
}

/**
 * Load and process all tasks with the same logic as CLI overview
 * This method extracts the common task loading logic for reuse
 */
export async function loadAllTasksForStatistics(
	core: Core,
	progressCallback?: (msg: string) => void,
): Promise<{ tasks: Task[]; drafts: Task[]; statuses: string[] }> {
	const config = await core.fs.loadConfig();
	const statuses = (config?.statuses || DEFAULT_STATUSES) as string[];
	const resolutionStrategy = config?.taskResolutionStrategy || "most_progressed";

	// Load local and completed tasks first
	progressCallback?.("Loading local tasks...");
	const [localTasks, completedTasks] = await Promise.all([listTasksWithMetadata(core), core.fs.listCompletedTasks()]);

	// Load remote tasks and local branch tasks in parallel
	const branchStateEntries: BranchTaskStateEntry[] | undefined = config?.checkActiveBranches === false ? undefined : [];
	const [remoteTasks, localBranchTasks] = await Promise.all([
		loadRemoteTasks(core.git, config, progressCallback, localTasks, branchStateEntries),
		loadLocalBranchTasks(core.git, config, progressCallback, localTasks, branchStateEntries),
	]);
	progressCallback?.("Loaded tasks");

	// Create map with local tasks
	const tasksById = new Map<string, Task>(localTasks.map((t) => [t.id, { ...t, source: "local" }]));

	// Add completed tasks to the map
	for (const completedTask of completedTasks) {
		if (!tasksById.has(completedTask.id)) {
			tasksById.set(completedTask.id, { ...completedTask, source: "completed" });
		}
	}

	// Merge tasks from other local branches
	progressCallback?.("Merging tasks...");
	for (const branchTask of localBranchTasks) {
		const existing = tasksById.get(branchTask.id);
		if (!existing) {
			tasksById.set(branchTask.id, branchTask);
		} else {
			const resolved = resolveTaskConflict(existing, branchTask, statuses, resolutionStrategy);
			tasksById.set(branchTask.id, resolved);
		}
	}

	// Merge remote tasks with local tasks
	for (const remoteTask of remoteTasks) {
		const existing = tasksById.get(remoteTask.id);
		if (!existing) {
			tasksById.set(remoteTask.id, remoteTask);
		} else {
			const resolved = resolveTaskConflict(existing, remoteTask, statuses, resolutionStrategy);
			tasksById.set(remoteTask.id, resolved);
		}
	}

	// Get all tasks as array
	const tasks = Array.from(tasksById.values());
	let activeTasks: Task[];

	if (config?.checkActiveBranches === false) {
		activeTasks = tasks;
	} else {
		progressCallback?.("Applying latest task states from branch scans...");
		activeTasks = filterTasksByStateSnapshots(tasks, buildLatestStateMap(branchStateEntries || [], localTasks));
	}

	// Load drafts
	progressCallback?.("Loading drafts...");
	const drafts = await core.fs.listDrafts();

	return { tasks: activeTasks, drafts, statuses: statuses as string[] };
}

/**
 * Load all tasks with cross-branch support
 * This is the single entry point for loading tasks across all interfaces
 */
export async function loadTasks(
	core: Core,
	progressCallback?: (msg: string) => void,
	abortSignal?: AbortSignal,
	options?: { includeCompleted?: boolean },
): Promise<Task[]> {
	const config = await core.fs.loadConfig();
	const statuses = config?.statuses || [...DEFAULT_STATUSES];
	const resolutionStrategy = config?.taskResolutionStrategy || "most_progressed";
	const includeCompleted = options?.includeCompleted ?? false;

	// Check for cancellation
	if (abortSignal?.aborted) {
		throw new Error("Loading cancelled");
	}

	// Load local filesystem tasks first (needed for optimization)
	const [localTasks, completedTasks] = await Promise.all([
		listTasksWithMetadata(core),
		includeCompleted ? core.fs.listCompletedTasks() : Promise.resolve([]),
	]);

	// Check for cancellation
	if (abortSignal?.aborted) {
		throw new Error("Loading cancelled");
	}

	// Load tasks from remote branches and other local branches in parallel
	progressCallback?.(getTaskLoadingMessage(config));

	const branchStateEntries: BranchTaskStateEntry[] | undefined = config?.checkActiveBranches === false ? undefined : [];
	const [remoteTasks, localBranchTasks] = await Promise.all([
		loadRemoteTasks(core.git, config, progressCallback, localTasks, branchStateEntries, includeCompleted),
		loadLocalBranchTasks(core.git, config, progressCallback, localTasks, branchStateEntries, includeCompleted),
	]);

	// Check for cancellation after loading
	if (abortSignal?.aborted) {
		throw new Error("Loading cancelled");
	}

	// Create map with local tasks (current branch filesystem)
	const tasksById = new Map<string, Task>(localTasks.map((t) => [t.id, { ...t, source: "local" }]));

	// Add local completed tasks when requested
	if (includeCompleted) {
		for (const completedTask of completedTasks) {
			tasksById.set(completedTask.id, { ...completedTask, source: "completed" });
		}
	}

	// Merge tasks from other local branches
	for (const branchTask of localBranchTasks) {
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		const existing = tasksById.get(branchTask.id);
		if (!existing) {
			tasksById.set(branchTask.id, branchTask);
		} else {
			const resolved = resolveTaskConflict(existing, branchTask, statuses, resolutionStrategy);
			tasksById.set(branchTask.id, resolved);
		}
	}

	// Merge remote tasks with local tasks
	for (const remoteTask of remoteTasks) {
		// Check for cancellation during merge
		if (abortSignal?.aborted) {
			throw new Error("Loading cancelled");
		}

		const existing = tasksById.get(remoteTask.id);
		if (!existing) {
			tasksById.set(remoteTask.id, remoteTask);
		} else {
			const resolved = resolveTaskConflict(existing, remoteTask, statuses, resolutionStrategy);
			tasksById.set(remoteTask.id, resolved);
		}
	}

	// Check for cancellation before cross-branch checking
	if (abortSignal?.aborted) {
		throw new Error("Loading cancelled");
	}

	// Get the latest directory location of each task across all branches
	const tasks = Array.from(tasksById.values());

	if (abortSignal?.aborted) {
		throw new Error("Loading cancelled");
	}

	let filteredTasks: Task[];

	if (config?.checkActiveBranches === false) {
		filteredTasks = tasks;
	} else {
		progressCallback?.("Applying latest task states from branch scans...");
		if (!includeCompleted) {
			filteredTasks = filterTasksByStateSnapshots(tasks, buildLatestStateMap(branchStateEntries || [], localTasks));
		} else {
			const stateEntries = branchStateEntries || [];
			for (const completedTask of completedTasks) {
				if (!completedTask.id) continue;
				const lastModified = completedTask.updatedDate ? new Date(completedTask.updatedDate) : new Date(0);
				stateEntries.push({
					id: completedTask.id,
					type: "completed",
					branch: "local",
					path: "",
					lastModified,
				});
			}

			const latestState = buildLatestStateMap(stateEntries, localTasks);
			const completedIds = new Set<string>();
			for (const [id, entry] of latestState) {
				if (entry.type === "completed") {
					completedIds.add(id);
				}
			}

			filteredTasks = tasks
				.filter((task) => {
					const latest = latestState.get(task.id);
					if (!latest) return true;
					return latest.type === "task" || latest.type === "completed";
				})
				.map((task) => {
					if (!completedIds.has(task.id)) {
						return task;
					}
					return { ...task, source: "completed" };
				});
		}
	}

	return filteredTasks;
}
