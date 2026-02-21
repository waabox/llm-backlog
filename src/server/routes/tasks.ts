import type { Core } from "../../core/backlog.ts";
import { milestoneKey, resolveMilestoneInput } from "../../core/milestones.ts";
import type { SearchPriorityFilter, SearchResultType, Task, TaskUpdateInput } from "../../types/index.ts";
import { PREFIX_PATTERN, parseTaskIdSegments } from "../../utils/task-search.ts";

const DEFAULT_PREFIX = "task-";

export function ensurePrefix(id: string): string {
	if (PREFIX_PATTERN.test(id)) {
		return id;
	}
	return `${DEFAULT_PREFIX}${id}`;
}

export function findTaskByLooseId(tasks: Task[], inputId: string): Task | undefined {
	// First try exact match (case-insensitive)
	const lowerInputId = inputId.toLowerCase();
	const exact = tasks.find((task) => task.id.toLowerCase() === lowerInputId);
	if (exact) {
		return exact;
	}

	// Try matching by numeric segments only
	const inputSegments = parseTaskIdSegments(inputId);
	if (!inputSegments) {
		return undefined;
	}

	return tasks.find((task) => {
		const candidateSegments = parseTaskIdSegments(task.id);
		if (!candidateSegments || candidateSegments.length !== inputSegments.length) {
			return false;
		}
		for (let index = 0; index < candidateSegments.length; index += 1) {
			if (candidateSegments[index] !== inputSegments[index]) {
				return false;
			}
		}
		return true;
	});
}

export async function handleListTasks(req: Request, core: Core): Promise<Response> {
	const url = new URL(req.url);
	const status = url.searchParams.get("status") || undefined;
	const assignee = url.searchParams.get("assignee") || undefined;
	const parent = url.searchParams.get("parent") || undefined;
	const priorityParam = url.searchParams.get("priority") || undefined;
	const crossBranch = url.searchParams.get("crossBranch") === "true";
	const labelParams = [...url.searchParams.getAll("label"), ...url.searchParams.getAll("labels")];
	const labelsCsv = url.searchParams.get("labels");
	if (labelsCsv) {
		labelParams.push(...labelsCsv.split(","));
	}
	const labels = labelParams.map((label) => label.trim()).filter((label) => label.length > 0);

	let priority: "high" | "medium" | "low" | undefined;
	if (priorityParam) {
		const normalizedPriority = priorityParam.toLowerCase();
		const allowed = ["high", "medium", "low"];
		if (!allowed.includes(normalizedPriority)) {
			return Response.json({ error: "Invalid priority filter" }, { status: 400 });
		}
		priority = normalizedPriority as "high" | "medium" | "low";
	}

	// Resolve parent task ID if provided
	let parentTaskId: string | undefined;
	if (parent) {
		const store = await core.getContentStore();
		const allTasks = store.getTasks();
		let parentTask = findTaskByLooseId(allTasks, parent);
		if (!parentTask) {
			const fallbackId = ensurePrefix(parent);
			const fallback = await core.filesystem.loadTask(fallbackId);
			if (fallback) {
				store.upsertTask(fallback);
				parentTask = fallback;
			}
		}
		if (!parentTask) {
			const normalizedParent = ensurePrefix(parent);
			return Response.json({ error: `Parent task ${normalizedParent} not found` }, { status: 404 });
		}
		parentTaskId = parentTask.id;
	}

	// Use Core.queryTasks which handles all filtering and cross-branch logic
	const tasks = await core.queryTasks({
		filters: { status, assignee, priority, parentTaskId, labels: labels.length > 0 ? labels : undefined },
		includeCrossBranch: crossBranch,
		excludeInactiveMilestones: true,
	});

	return Response.json(tasks);
}

export async function handleSearch(req: Request, core: Core): Promise<Response> {
	try {
		const searchService = await core.getSearchService();
		const url = new URL(req.url);
		const query = url.searchParams.get("query") ?? undefined;
		const limitParam = url.searchParams.get("limit");
		const typeParams = [...url.searchParams.getAll("type"), ...url.searchParams.getAll("types")];
		const statusParams = url.searchParams.getAll("status");
		const priorityParamsRaw = url.searchParams.getAll("priority");
		const labelParamsRaw = [...url.searchParams.getAll("label"), ...url.searchParams.getAll("labels")];
		const labelsCsv = url.searchParams.get("labels");
		if (labelsCsv) {
			labelParamsRaw.push(...labelsCsv.split(","));
		}

		let limit: number | undefined;
		if (limitParam) {
			const parsed = Number.parseInt(limitParam, 10);
			if (Number.isNaN(parsed) || parsed <= 0) {
				return Response.json({ error: "limit must be a positive integer" }, { status: 400 });
			}
			limit = parsed;
		}

		let types: SearchResultType[] | undefined;
		if (typeParams.length > 0) {
			const allowed: SearchResultType[] = ["task", "document", "decision"];
			const normalizedTypes = typeParams
				.map((value) => value.toLowerCase())
				.filter((value): value is SearchResultType => {
					return allowed.includes(value as SearchResultType);
				});
			if (normalizedTypes.length === 0) {
				return Response.json({ error: "type must be task, document, or decision" }, { status: 400 });
			}
			types = normalizedTypes;
		}

		const filters: {
			status?: string | string[];
			priority?: SearchPriorityFilter | SearchPriorityFilter[];
			labels?: string | string[];
		} = {};

		if (statusParams.length === 1) {
			filters.status = statusParams[0];
		} else if (statusParams.length > 1) {
			filters.status = statusParams;
		}

		if (priorityParamsRaw.length > 0) {
			const allowedPriorities: SearchPriorityFilter[] = ["high", "medium", "low"];
			const normalizedPriorities = priorityParamsRaw.map((value) => value.toLowerCase());
			const invalidPriority = normalizedPriorities.find(
				(value) => !allowedPriorities.includes(value as SearchPriorityFilter),
			);
			if (invalidPriority) {
				return Response.json(
					{ error: `Unsupported priority '${invalidPriority}'. Use high, medium, or low.` },
					{ status: 400 },
				);
			}
			const casted = normalizedPriorities as SearchPriorityFilter[];
			filters.priority = casted.length === 1 ? casted[0] : casted;
		}

		if (labelParamsRaw.length > 0) {
			const normalizedLabels = labelParamsRaw.map((value) => value.trim()).filter((value) => value.length > 0);
			if (normalizedLabels.length > 0) {
				filters.labels = normalizedLabels.length === 1 ? normalizedLabels[0] : normalizedLabels;
			}
		}

		const results = searchService.search({ query, limit, types, filters });

		const milestones = await core.fs.listMilestones();
		const inactive = milestones.filter((m) => !m.active);
		if (inactive.length > 0) {
			const inactiveKeys = new Set(inactive.map((m) => milestoneKey(m.id)));
			const filtered = results.filter((result) => {
				if (result.type !== "task") return true;
				const key = milestoneKey(result.task.milestone ?? "");
				return !key || !inactiveKeys.has(key);
			});
			return Response.json(filtered);
		}

		return Response.json(results);
	} catch (error) {
		console.error("Error performing search:", error);
		return Response.json({ error: "Search failed" }, { status: 500 });
	}
}

export async function handleCreateTask(req: Request, core: Core, broadcast: () => void): Promise<Response> {
	const payload = await req.json();

	if (!payload || typeof payload.title !== "string" || payload.title.trim().length === 0) {
		return Response.json({ error: "Title is required" }, { status: 400 });
	}

	try {
		let milestone: string | undefined;
		if (typeof payload.milestone === "string") {
			const [activeMilestones, archivedMilestones] = await Promise.all([
				core.filesystem.listMilestones(),
				core.filesystem.listArchivedMilestones(),
			]);
			milestone = resolveMilestoneInput(payload.milestone, activeMilestones, archivedMilestones);
		}

		const { task: createdTask } = await core.createTaskFromInput({
			title: payload.title,
			description: payload.description,
			status: payload.status,
			priority: payload.priority,
			milestone,
			labels: payload.labels,
			assignee: payload.assignee,
			dependencies: payload.dependencies,
			references: payload.references,
			parentTaskId: payload.parentTaskId,
			implementationPlan: payload.implementationPlan,
			finalSummary: payload.finalSummary,
		});
		broadcast();
		return Response.json(createdTask, { status: 201 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to create task";
		return Response.json({ error: message }, { status: 400 });
	}
}

export async function handleGetTask(taskId: string, core: Core): Promise<Response> {
	const store = await core.getContentStore();
	const tasks = store.getTasks();
	const task = findTaskByLooseId(tasks, taskId);
	if (!task) {
		const fallbackId = ensurePrefix(taskId);
		const fallback = await core.filesystem.loadTask(fallbackId);
		if (fallback) {
			store.upsertTask(fallback);
			return Response.json(fallback);
		}
		return Response.json({ error: "Task not found" }, { status: 404 });
	}
	return Response.json(task);
}

export async function handleUpdateTask(
	req: Request,
	taskId: string,
	core: Core,
	broadcast: () => void,
): Promise<Response> {
	const updates = await req.json();
	const existingTask = await core.filesystem.loadTask(taskId);
	if (!existingTask) {
		return Response.json({ error: "Task not found" }, { status: 404 });
	}

	const updateInput: TaskUpdateInput = {};

	if ("title" in updates && typeof updates.title === "string") {
		updateInput.title = updates.title;
	}

	if ("description" in updates && typeof updates.description === "string") {
		updateInput.description = updates.description;
	}

	if ("status" in updates && typeof updates.status === "string") {
		updateInput.status = updates.status;
	}

	if ("priority" in updates && typeof updates.priority === "string") {
		updateInput.priority = updates.priority;
	}

	if ("milestone" in updates && (typeof updates.milestone === "string" || updates.milestone === null)) {
		if (typeof updates.milestone === "string") {
			const [activeMilestones, archivedMilestones] = await Promise.all([
				core.filesystem.listMilestones(),
				core.filesystem.listArchivedMilestones(),
			]);
			updateInput.milestone = resolveMilestoneInput(updates.milestone, activeMilestones, archivedMilestones);
		} else {
			updateInput.milestone = updates.milestone;
		}
	}

	if ("labels" in updates && Array.isArray(updates.labels)) {
		updateInput.labels = updates.labels;
	}

	if ("assignee" in updates && Array.isArray(updates.assignee)) {
		updateInput.assignee = updates.assignee;
	}

	if ("dependencies" in updates && Array.isArray(updates.dependencies)) {
		updateInput.dependencies = updates.dependencies;
	}

	if ("references" in updates && Array.isArray(updates.references)) {
		updateInput.references = updates.references;
	}

	if ("implementationPlan" in updates && typeof updates.implementationPlan === "string") {
		updateInput.implementationPlan = updates.implementationPlan;
	}

	if ("finalSummary" in updates && typeof updates.finalSummary === "string") {
		updateInput.finalSummary = updates.finalSummary;
	}

	try {
		const updatedTask = await core.updateTaskFromInput(taskId, updateInput);
		broadcast();
		return Response.json(updatedTask);
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to update task";
		return Response.json({ error: message }, { status: 400 });
	}
}

export async function handleDeleteTask(taskId: string, core: Core): Promise<Response> {
	const success = await core.archiveTask(taskId);
	if (!success) {
		return Response.json({ error: "Task not found" }, { status: 404 });
	}
	return Response.json({ success: true });
}

export async function handleCompleteTask(taskId: string, core: Core, broadcast: () => void): Promise<Response> {
	try {
		const task = await core.filesystem.loadTask(taskId);
		if (!task) {
			return Response.json({ error: "Task not found" }, { status: 404 });
		}

		const success = await core.completeTask(taskId);
		if (!success) {
			return Response.json({ error: "Failed to complete task" }, { status: 500 });
		}

		// Notify listeners to refresh
		broadcast();
		return Response.json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to complete task";
		console.error("Error completing task:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleReorderTask(req: Request, core: Core): Promise<Response> {
	try {
		const body = await req.json();
		const taskId = typeof body.taskId === "string" ? body.taskId : "";
		const targetStatus = typeof body.targetStatus === "string" ? body.targetStatus : "";
		const orderedTaskIds = Array.isArray(body.orderedTaskIds) ? body.orderedTaskIds : [];
		const targetMilestone =
			typeof body.targetMilestone === "string"
				? body.targetMilestone
				: body.targetMilestone === null
					? null
					: undefined;

		if (!taskId || !targetStatus || orderedTaskIds.length === 0) {
			return Response.json(
				{ error: "Missing required fields: taskId, targetStatus, and orderedTaskIds" },
				{ status: 400 },
			);
		}

		const { updatedTask } = await core.reorderTask({
			taskId,
			targetStatus,
			orderedTaskIds,
			targetMilestone,
			commitMessage: `Reorder tasks in ${targetStatus}`,
		});

		return Response.json({ success: true, task: updatedTask });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to reorder task";
		// Cross-branch and validation errors are client errors (400), not server errors (500)
		const isCrossBranchError = message.includes("exists in branch");
		const isValidationError = message.includes("not found") || message.includes("Missing required");
		const status = isCrossBranchError || isValidationError ? 400 : 500;
		if (status === 500) {
			console.error("Error reordering task:", error);
		}
		return Response.json({ error: message }, { status });
	}
}

export async function handleCleanupPreview(req: Request, core: Core): Promise<Response> {
	try {
		const url = new URL(req.url);
		const ageParam = url.searchParams.get("age");

		if (!ageParam) {
			return Response.json({ error: "Missing age parameter" }, { status: 400 });
		}

		const age = Number.parseInt(ageParam, 10);
		if (Number.isNaN(age) || age < 0) {
			return Response.json({ error: "Invalid age parameter" }, { status: 400 });
		}

		// Get Done tasks older than specified days
		const tasksToCleanup = await core.getDoneTasksByAge(age);

		// Return preview of tasks to be cleaned up
		const preview = tasksToCleanup.map((task) => ({
			id: task.id,
			title: task.title,
			updatedDate: task.updatedDate,
			createdDate: task.createdDate,
		}));

		return Response.json({
			count: preview.length,
			tasks: preview,
		});
	} catch (error) {
		console.error("Error getting cleanup preview:", error);
		return Response.json({ error: "Failed to get cleanup preview" }, { status: 500 });
	}
}

export async function handleCleanupExecute(req: Request, core: Core, broadcast: () => void): Promise<Response> {
	try {
		const { age } = await req.json();

		if (age === undefined || age === null) {
			return Response.json({ error: "Missing age parameter" }, { status: 400 });
		}

		const ageInDays = Number.parseInt(age, 10);
		if (Number.isNaN(ageInDays) || ageInDays < 0) {
			return Response.json({ error: "Invalid age parameter" }, { status: 400 });
		}

		// Get Done tasks older than specified days
		const tasksToCleanup = await core.getDoneTasksByAge(ageInDays);

		if (tasksToCleanup.length === 0) {
			return Response.json({
				success: true,
				movedCount: 0,
				message: "No tasks to clean up",
			});
		}

		// Move tasks to completed folder
		let successCount = 0;
		const failedTasks: string[] = [];

		for (const task of tasksToCleanup) {
			try {
				const success = await core.completeTask(task.id);
				if (success) {
					successCount++;
				} else {
					failedTasks.push(task.id);
				}
			} catch (error) {
				console.error(`Failed to complete task ${task.id}:`, error);
				failedTasks.push(task.id);
			}
		}

		// Notify listeners to refresh
		broadcast();

		return Response.json({
			success: true,
			movedCount: successCount,
			totalCount: tasksToCleanup.length,
			failedTasks: failedTasks.length > 0 ? failedTasks : undefined,
			message: `Moved ${successCount} of ${tasksToCleanup.length} tasks to completed folder`,
		});
	} catch (error) {
		console.error("Error executing cleanup:", error);
		return Response.json({ error: "Failed to execute cleanup" }, { status: 500 });
	}
}
