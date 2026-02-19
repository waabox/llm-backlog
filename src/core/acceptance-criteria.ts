import type { AcceptanceCriterion } from "../types/index.ts";
import type { Core } from "./backlog.ts";

/**
 * Add acceptance criteria to a task
 */
export async function addAcceptanceCriteria(
	core: Core,
	taskId: string,
	criteria: string[],
	autoCommit?: boolean,
): Promise<void> {
	const task = await core.fs.loadTask(taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}

	// Get existing criteria or initialize empty array
	const current = Array.isArray(task.acceptanceCriteriaItems) ? [...task.acceptanceCriteriaItems] : [];

	// Calculate next index (1-based)
	let nextIndex = current.length > 0 ? Math.max(...current.map((c) => c.index)) + 1 : 1;

	// Append new criteria
	const newCriteria = criteria.map((text) => ({ index: nextIndex++, text, checked: false }));
	task.acceptanceCriteriaItems = [...current, ...newCriteria];

	// Save the task
	await core.updateTask(task, autoCommit);
}

/**
 * Remove acceptance criteria by indices (supports batch operations)
 * @returns Array of removed indices
 */
export async function removeAcceptanceCriteria(
	core: Core,
	taskId: string,
	indices: number[],
	autoCommit?: boolean,
): Promise<number[]> {
	const task = await core.fs.loadTask(taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}

	let list = Array.isArray(task.acceptanceCriteriaItems) ? [...task.acceptanceCriteriaItems] : [];
	const removed: number[] = [];

	// Sort indices in descending order to avoid index shifting issues
	const sortedIndices = [...indices].sort((a, b) => b - a);

	for (const idx of sortedIndices) {
		const before = list.length;
		list = list.filter((c) => c.index !== idx);
		if (list.length < before) {
			removed.push(idx);
		}
	}

	if (removed.length === 0) {
		throw new Error("No criteria were removed. Check that the specified indices exist.");
	}

	// Re-index remaining items (1-based)
	list = list.map((c, i) => ({ ...c, index: i + 1 }));
	task.acceptanceCriteriaItems = list;

	// Save the task
	await core.updateTask(task, autoCommit);

	return removed.sort((a, b) => a - b); // Return in ascending order
}

/**
 * Check or uncheck acceptance criteria by indices (supports batch operations)
 * Silently ignores invalid indices and only updates valid ones.
 * @returns Array of updated indices
 */
export async function checkAcceptanceCriteria(
	core: Core,
	taskId: string,
	indices: number[],
	checked: boolean,
	autoCommit?: boolean,
): Promise<number[]> {
	const task = await core.fs.loadTask(taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}

	let list = Array.isArray(task.acceptanceCriteriaItems) ? [...task.acceptanceCriteriaItems] : [];
	const updated: number[] = [];

	// Filter to only valid indices and update them
	for (const idx of indices) {
		if (list.some((c) => c.index === idx)) {
			list = list.map((c) => {
				if (c.index === idx) {
					updated.push(idx);
					return { ...c, checked };
				}
				return c;
			});
		}
	}

	if (updated.length === 0) {
		throw new Error("No criteria were updated.");
	}

	task.acceptanceCriteriaItems = list;

	// Save the task
	await core.updateTask(task, autoCommit);

	return updated.sort((a, b) => a - b);
}

/**
 * List all acceptance criteria for a task
 */
export async function listAcceptanceCriteria(core: Core, taskId: string): Promise<AcceptanceCriterion[]> {
	const task = await core.fs.loadTask(taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}

	return task.acceptanceCriteriaItems || [];
}
