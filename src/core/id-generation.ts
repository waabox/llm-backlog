import { EntityType } from "../types/index.ts";
import { buildIdRegex, getPrefixForType } from "../utils/prefix-config.ts";
import { normalizeTaskId, taskIdsEqual } from "../utils/task-path.ts";
import type { Core } from "./backlog.ts";
import { type BranchTaskStateEntry, loadLocalBranchTasks, loadRemoteTasks } from "./task-loader.ts";
import { buildLatestStateMap, getActiveAndCompletedIdsFromStateMap, listTasksWithMetadata } from "./task-query.ts";

/**
 * Gets all task IDs that are in use (active or completed) across all branches.
 * Respects cross-branch config settings. Archived IDs are excluded (can be reused).
 *
 * This is used for ID generation to determine the next available ID.
 */
async function getActiveAndCompletedTaskIds(core: Core): Promise<string[]> {
	const config = await core.fs.loadConfig();

	// Load local active and completed tasks
	const localTasks = await listTasksWithMetadata(core);
	const localCompletedTasks = await core.fs.listCompletedTasks();

	// Build initial state entries from local tasks
	const stateEntries: BranchTaskStateEntry[] = [];

	// Add local active tasks to state
	for (const task of localTasks) {
		if (!task.id) continue;
		const lastModified = task.lastModified ?? (task.updatedDate ? new Date(task.updatedDate) : new Date(0));
		stateEntries.push({
			id: task.id,
			type: "task",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	// Add local completed tasks to state
	for (const task of localCompletedTasks) {
		if (!task.id) continue;
		const lastModified = task.updatedDate ? new Date(task.updatedDate) : new Date(0);
		stateEntries.push({
			id: task.id,
			type: "completed",
			branch: "local",
			path: "",
			lastModified,
		});
	}

	// If cross-branch checking is enabled, scan other branches for task states
	if (config?.checkActiveBranches !== false) {
		const branchStateEntries: BranchTaskStateEntry[] = [];

		// Load states from remote and local branches in parallel
		await Promise.all([
			loadRemoteTasks(core.git, config, undefined, localTasks, branchStateEntries),
			loadLocalBranchTasks(core.git, config, undefined, localTasks, branchStateEntries),
		]);

		// Add branch state entries
		stateEntries.push(...branchStateEntries);
	}

	// Build the latest state map and extract active + completed IDs
	const latestState = buildLatestStateMap(stateEntries, []);
	return getActiveAndCompletedIdsFromStateMap(latestState);
}

/**
 * Gets all existing IDs for a given entity type.
 * Used internally by generateNextId to determine the next available ID.
 *
 * Note: Archived tasks are intentionally excluded - archived IDs can be reused.
 * This makes archive act as a soft delete for ID purposes.
 */
async function getExistingIdsForType(core: Core, type: EntityType): Promise<string[]> {
	switch (type) {
		case EntityType.Task: {
			// Get active + completed task IDs from all branches (respects config)
			// Archived IDs are excluded - they can be reused (soft delete behavior)
			return getActiveAndCompletedTaskIds(core);
		}
		case EntityType.Draft: {
			const drafts = await core.fs.listDrafts();
			return drafts.map((d) => d.id);
		}
		case EntityType.Document: {
			const documents = await core.fs.listDocuments();
			return documents.map((d) => d.id);
		}
		case EntityType.Decision: {
			const decisions = await core.fs.listDecisions();
			return decisions.map((d) => d.id);
		}
		default:
			return [];
	}
}

/**
 * Generates the next ID for a given entity type.
 *
 * @param core - The Core instance.
 * @param type - The entity type (Task, Draft, Document, Decision). Defaults to Task.
 * @param parent - Optional parent ID for subtask generation (only applicable for tasks).
 * @returns The next available ID (e.g., "task-42", "draft-5", "doc-3")
 *
 * Folder scanning by type:
 * - Task: /tasks, /completed, cross-branch (if enabled), remote (if enabled)
 * - Draft: /drafts only
 * - Document: /documents only
 * - Decision: /decisions only
 */
export async function generateNextId(core: Core, type: EntityType = EntityType.Task, parent?: string): Promise<string> {
	const config = await core.fs.loadConfig();
	const prefix = getPrefixForType(type, config ?? undefined);

	// Collect existing IDs based on entity type
	const allIds = await getExistingIdsForType(core, type);

	if (parent) {
		// Subtask generation (only applicable for tasks)
		const normalizedParent = allIds.find((id) => taskIdsEqual(parent, id)) ?? normalizeTaskId(parent);
		const upperParent = normalizedParent.toUpperCase();
		let max = 0;
		for (const id of allIds) {
			// Case-insensitive comparison to handle legacy lowercase IDs
			if (id.toUpperCase().startsWith(`${upperParent}.`)) {
				const rest = id.slice(normalizedParent.length + 1);
				const num = Number.parseInt(rest.split(".")[0] || "0", 10);
				if (num > max) max = num;
			}
		}
		const nextSubIdNumber = max + 1;
		const padding = config?.zeroPaddedIds;

		if (padding && padding > 0) {
			const paddedSubId = String(nextSubIdNumber).padStart(2, "0");
			return `${normalizedParent}.${paddedSubId}`;
		}

		return `${normalizedParent}.${nextSubIdNumber}`;
	}

	// Top-level ID generation using prefix-aware regex
	const regex = buildIdRegex(prefix);
	const upperPrefix = prefix.toUpperCase();
	let max = 0;
	for (const id of allIds) {
		const match = id.match(regex);
		if (match?.[1] && !match[1].includes(".")) {
			const num = Number.parseInt(match[1], 10);
			if (num > max) max = num;
		}
	}
	const nextIdNumber = max + 1;
	const padding = config?.zeroPaddedIds;

	if (padding && padding > 0) {
		const paddedId = String(nextIdNumber).padStart(padding, "0");
		return `${upperPrefix}-${paddedId}`;
	}

	return `${upperPrefix}-${nextIdNumber}`;
}
