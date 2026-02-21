import { rename as moveFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import type { Milestone, Task } from "../types/index.ts";
import { normalizeId } from "../utils/prefix-config.ts";
import { getTaskFilename, getTaskPath, isSubtaskId, normalizeTaskId } from "../utils/task-path.ts";
import type { Core } from "./backlog.ts";
import { sanitizeArchivedTaskLinks } from "./task-mutation.ts";

/**
 * Archives a task by moving it to the archive directory.
 * Sanitizes any active task links that reference the archived task.
 *
 * @param core - The Core instance.
 * @param taskId - The ID of the task to archive.
 * @param autoCommit - Whether to commit the change to git.
 * @returns True if the task was archived, false if the task was not found.
 */
export async function archiveTask(core: Core, taskId: string, autoCommit?: boolean): Promise<boolean> {
	const taskToArchive = await core.fs.loadTask(taskId);
	if (!taskToArchive) {
		return false;
	}
	const normalizedTaskId = taskToArchive.id;

	// Get paths before moving the file
	const taskPath = taskToArchive.filePath ?? (await getTaskPath(normalizedTaskId, core));
	const taskFilename = await getTaskFilename(normalizedTaskId, core);

	if (!taskPath || !taskFilename) return false;

	const fromPath = taskPath;
	const toPath = join(await core.fs.getArchiveTasksDir(), taskFilename);

	const success = await core.fs.archiveTask(normalizedTaskId);
	if (!success) {
		return false;
	}

	const activeTasks = await core.fs.listTasks();
	const sanitizedTasks = sanitizeArchivedTaskLinks(activeTasks, normalizedTaskId);
	if (sanitizedTasks.length > 0) {
		await core.updateTasksBulk(sanitizedTasks, undefined, false);
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		if (isSubtaskId(normalizedTaskId)) {
			// Single file move — stage precisely
			const repoRoot = await core.git.stageFileMove(fromPath, toPath);
			for (const sanitizedTask of sanitizedTasks) {
				if (sanitizedTask.filePath) {
					await core.git.addFile(sanitizedTask.filePath);
				}
			}
			await core.git.commitChanges(`backlog: Archive task ${normalizedTaskId}`, repoRoot);
		} else {
			// Folder move — stage the entire backlog directory
			const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
			await core.git.commitChanges(`backlog: Archive task ${normalizedTaskId}`, repoRoot);
		}
	}

	return true;
}

/**
 * Archives a milestone by moving it to the archive directory.
 *
 * @param core - The Core instance.
 * @param identifier - The milestone ID or name.
 * @param autoCommit - Whether to commit the change to git.
 * @returns Result object with success status and file paths.
 */
export async function archiveMilestone(
	core: Core,
	identifier: string,
	autoCommit?: boolean,
): Promise<{ success: boolean; sourcePath?: string; targetPath?: string; milestone?: Milestone }> {
	const result = await core.fs.archiveMilestone(identifier);

	if (result.success && result.sourcePath && result.targetPath && (await core.shouldAutoCommit(autoCommit))) {
		const repoRoot = await core.git.stageFileMove(result.sourcePath, result.targetPath);
		const label = result.milestone?.id ? ` ${result.milestone.id}` : "";
		const commitPaths = [result.sourcePath, result.targetPath];
		try {
			await core.git.commitFiles(`backlog: Archive milestone${label}`, commitPaths, repoRoot);
		} catch (error) {
			await core.git.resetPaths(commitPaths, repoRoot);
			try {
				await moveFile(result.targetPath, result.sourcePath);
			} catch {
				// Ignore rollback failure and propagate original commit error.
			}
			throw error;
		}
	}

	return {
		success: result.success,
		sourcePath: result.sourcePath,
		targetPath: result.targetPath,
		milestone: result.milestone,
	};
}

/**
 * Renames a milestone.
 *
 * @param core - The Core instance.
 * @param identifier - The milestone ID or name.
 * @param title - The new title for the milestone.
 * @param autoCommit - Whether to commit the change to git.
 * @returns Result object with success status and file paths.
 */
export async function renameMilestone(
	core: Core,
	identifier: string,
	title: string,
	autoCommit?: boolean,
): Promise<{
	success: boolean;
	sourcePath?: string;
	targetPath?: string;
	milestone?: Milestone;
	previousTitle?: string;
}> {
	const result = await core.fs.renameMilestone(identifier, title);
	if (!result.success) {
		return result;
	}

	if (result.sourcePath && result.targetPath && (await core.shouldAutoCommit(autoCommit))) {
		const repoRoot = await core.git.stageFileMove(result.sourcePath, result.targetPath);
		const label = result.milestone?.id ? ` ${result.milestone.id}` : "";
		const commitPaths = [result.sourcePath, result.targetPath];
		try {
			await core.git.commitFiles(`backlog: Rename milestone${label}`, commitPaths, repoRoot);
		} catch (error) {
			await core.git.resetPaths(commitPaths, repoRoot);
			const rollbackTitle = result.previousTitle ?? title;
			await core.fs.renameMilestone(result.milestone?.id ?? identifier, rollbackTitle);
			throw error;
		}
	}

	return result;
}

/**
 * Completes a task by moving it to the completed directory.
 *
 * @param core - The Core instance.
 * @param taskId - The ID of the task to complete.
 * @param autoCommit - Whether to commit the change to git.
 * @returns True if the task was completed, false if the task was not found.
 */
export async function completeTask(core: Core, taskId: string, autoCommit?: boolean): Promise<boolean> {
	// Get paths before moving the file
	const completedDir = core.fs.completedDir;
	const taskPath = await getTaskPath(taskId, core);
	const taskFilename = await getTaskFilename(taskId, core);

	if (!taskPath || !taskFilename) return false;

	const fromPath = taskPath;
	const toPath = join(completedDir, taskFilename);

	const success = await core.fs.completeTask(taskId);

	if (success && (await core.shouldAutoCommit(autoCommit))) {
		if (isSubtaskId(normalizeTaskId(taskId))) {
			const repoRoot = await core.git.stageFileMove(fromPath, toPath);
			await core.git.commitChanges(`backlog: Complete task ${normalizeTaskId(taskId)}`, repoRoot);
		} else {
			const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
			await core.git.commitChanges(`backlog: Complete task ${normalizeTaskId(taskId)}`, repoRoot);
		}
	}

	return success;
}

/**
 * Returns tasks with status "Done" that are older than the given number of days.
 *
 * @param core - The Core instance.
 * @param olderThanDays - The minimum age in days for a task to be included.
 * @returns List of done tasks older than the threshold.
 */
export async function getDoneTasksByAge(core: Core, olderThanDays: number): Promise<Task[]> {
	const tasks = await core.fs.listTasks();
	const cutoffDate = new Date();
	cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

	return tasks.filter((task) => {
		if (task.status !== "Done") return false;

		// Check updatedDate first, then createdDate as fallback
		const taskDate = task.updatedDate || task.createdDate;
		if (!taskDate) return false;

		const date = new Date(taskDate);
		return date < cutoffDate;
	});
}

/**
 * Archives a draft by moving it to the archive directory.
 *
 * @param core - The Core instance.
 * @param draftId - The ID of the draft to archive.
 * @param autoCommit - Whether to commit the change to git.
 * @returns True if the draft was archived, false otherwise.
 */
export async function archiveDraft(core: Core, draftId: string, autoCommit?: boolean): Promise<boolean> {
	const success = await core.fs.archiveDraft(draftId);

	if (success && (await core.shouldAutoCommit(autoCommit))) {
		const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
		await core.git.commitChanges(`backlog: Archive draft ${normalizeId(draftId, "draft")}`, repoRoot);
	}

	return success;
}

/**
 * Promotes a draft to a task by moving it out of the drafts directory.
 *
 * @param core - The Core instance.
 * @param draftId - The ID of the draft to promote.
 * @param autoCommit - Whether to commit the change to git.
 * @returns True if the draft was promoted, false otherwise.
 */
export async function promoteDraft(core: Core, draftId: string, autoCommit?: boolean): Promise<boolean> {
	const success = await core.fs.promoteDraft(draftId);

	if (success && (await core.shouldAutoCommit(autoCommit))) {
		const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
		await core.git.commitChanges(`backlog: Promote draft ${normalizeId(draftId, "draft")}`, repoRoot);
	}

	return success;
}

/**
 * Demotes a task to a draft by moving it to the drafts directory.
 *
 * @param core - The Core instance.
 * @param taskId - The ID of the task to demote.
 * @param autoCommit - Whether to commit the change to git.
 * @returns True if the task was demoted, false otherwise.
 */
export async function demoteTask(core: Core, taskId: string, autoCommit?: boolean): Promise<boolean> {
	const success = await core.fs.demoteTask(taskId);

	if (success && (await core.shouldAutoCommit(autoCommit))) {
		const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
		await core.git.commitChanges(`backlog: Demote task ${normalizeTaskId(taskId)}`, repoRoot);
	}

	return success;
}

/**
 * Sets the active state of a milestone.
 *
 * @param core - The Core instance.
 * @param identifier - The milestone ID or name.
 * @param active - Whether the milestone is active.
 * @param autoCommit - Whether to commit the change to git.
 * @returns Result object with success status and updated milestone.
 */
export async function setMilestoneActive(
	core: Core,
	identifier: string,
	active: boolean,
	autoCommit?: boolean,
): Promise<{ success: boolean; milestone?: Milestone }> {
	const result = await core.fs.updateMilestoneActive(identifier, active);
	if (!result.success || !result.milestone) {
		return { success: false };
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		const label = result.milestone.id ? ` ${result.milestone.id}` : "";
		const backlogDir = DEFAULT_DIRECTORIES.BACKLOG;
		const repoRoot = await core.git.stageBacklogDirectory(backlogDir);
		await core.git.commitChanges(`backlog: Set milestone${label} active=${active}`, repoRoot);
	}

	return { success: true, milestone: result.milestone };
}
