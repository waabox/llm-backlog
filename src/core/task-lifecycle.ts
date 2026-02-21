import { unlink } from "node:fs/promises";
import { DEFAULT_DIRECTORIES, FALLBACK_STATUS } from "../constants/index.ts";
import { EntityType, type Sequence, type Task, type TaskCreateInput, type TaskUpdateInput } from "../types/index.ts";
import { normalizeAssignee } from "../utils/assignee.ts";
import { normalizeId } from "../utils/prefix-config.ts";
import { executeStatusCallback } from "../utils/status-callback.ts";
import { normalizeDependencies, normalizeStringList, validateDependencies } from "../utils/task-builders.ts";
import { getTaskPath, normalizeTaskId } from "../utils/task-path.ts";
import type { Core } from "./backlog.ts";
import { calculateNewOrdinal, DEFAULT_ORDINAL_STEP, resolveOrdinalConflicts } from "./reorder.ts";
import { computeSequences, planMoveToSequence, planMoveToUnsequenced } from "./sequences.ts";
import { applyTaskUpdateInput, normalizePriority } from "./task-mutation.ts";
import { getTask } from "./task-query.ts";

export async function createTaskFromData(
	core: Core,
	taskData: {
		title: string;
		status?: string;
		assignee?: string[];
		labels?: string[];
		dependencies?: string[];
		parentTaskId?: string;
		priority?: "high" | "medium" | "low";
		description?: string;
		implementationPlan?: string;
		finalSummary?: string;
		milestone?: string;
	},
	autoCommit?: boolean,
): Promise<Task> {
	const isDraft = taskData.status?.toLowerCase() === "draft";
	const entityType = isDraft ? EntityType.Draft : EntityType.Task;
	const id = await core.generateNextId(entityType, isDraft ? undefined : taskData.parentTaskId);

	const task: Task = {
		id,
		title: taskData.title,
		status: taskData.status || "",
		assignee: taskData.assignee || [],
		labels: taskData.labels || [],
		dependencies: taskData.dependencies || [],
		rawContent: "",
		createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
		...(taskData.parentTaskId && { parentTaskId: taskData.parentTaskId }),
		...(taskData.priority && { priority: taskData.priority }),
		...(typeof taskData.milestone === "string" &&
			taskData.milestone.trim().length > 0 && {
				milestone: taskData.milestone.trim(),
			}),
		...(typeof taskData.description === "string" && { description: taskData.description }),
		...(typeof taskData.implementationPlan === "string" && { implementationPlan: taskData.implementationPlan }),
		...(typeof taskData.finalSummary === "string" && { finalSummary: taskData.finalSummary }),
	};

	if (isDraft) {
		await createDraft(core, task, autoCommit);
	} else {
		await createTask(core, task, autoCommit);
	}

	return task;
}

export async function createTaskFromInput(
	core: Core,
	input: TaskCreateInput,
	autoCommit?: boolean,
): Promise<{ task: Task; filePath?: string }> {
	if (!input.title || input.title.trim().length === 0) {
		throw new Error("Title is required to create a task.");
	}

	const requestedStatus = input.status?.trim();
	const isDraft = requestedStatus?.toLowerCase() === "draft";

	const entityType = isDraft ? EntityType.Draft : EntityType.Task;
	const id = await core.generateNextId(entityType, isDraft ? undefined : input.parentTaskId);

	const normalizedLabels = normalizeStringList(input.labels) ?? [];
	const normalizedAssignees = normalizeStringList(input.assignee) ?? [];
	const normalizedDependencies = normalizeDependencies(input.dependencies);
	const normalizedReferences = normalizeStringList(input.references) ?? [];
	const normalizedDocumentation = normalizeStringList(input.documentation) ?? [];

	const { valid: validDependencies, invalid: invalidDependencies } = await validateDependencies(
		normalizedDependencies,
		core,
	);
	if (invalidDependencies.length > 0) {
		throw new Error(
			`The following dependencies do not exist: ${invalidDependencies.join(", ")}. Please create these tasks first or verify the IDs.`,
		);
	}

	let status = "";
	if (requestedStatus) {
		if (isDraft) {
			status = "Draft";
		} else {
			status = await core.requireCanonicalStatus(requestedStatus);
		}
	}

	const priority = normalizePriority(input.priority);
	const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");

	const task: Task = {
		id,
		title: input.title.trim(),
		status,
		assignee: normalizedAssignees,
		labels: normalizedLabels,
		dependencies: validDependencies,
		references: normalizedReferences,
		documentation: normalizedDocumentation,
		rawContent: input.rawContent ?? "",
		createdDate,
		...(input.parentTaskId && { parentTaskId: input.parentTaskId }),
		...(priority && { priority }),
		...(typeof input.milestone === "string" &&
			input.milestone.trim().length > 0 && {
				milestone: input.milestone.trim(),
			}),
		...(typeof input.description === "string" && { description: input.description }),
		...(typeof input.implementationPlan === "string" && { implementationPlan: input.implementationPlan }),
		...(typeof input.finalSummary === "string" && { finalSummary: input.finalSummary }),
	};

	const filePath = isDraft ? await createDraft(core, task, autoCommit) : await createTask(core, task, autoCommit);

	const savedTask = isDraft ? await core.fs.loadDraft(id) : await core.fs.loadTask(id);
	return { task: savedTask ?? task, filePath };
}

export async function createTask(core: Core, task: Task, autoCommit?: boolean): Promise<string> {
	if (!task.status) {
		const config = await core.fs.loadConfig();
		task.status = config?.defaultStatus || FALLBACK_STATUS;
	}

	normalizeAssignee(task);

	const filepath = await core.fs.saveTask(task);
	if (core.contentStore) {
		const savedTask = await core.fs.loadTask(task.id);
		if (savedTask) {
			core.contentStore.upsertTask(savedTask);
		}
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		await core.git.addAndCommitTaskFile(task.id, filepath, "create");
	}

	return filepath;
}

export async function createDraft(core: Core, task: Task, autoCommit?: boolean): Promise<string> {
	task.status = "Draft";
	normalizeAssignee(task);

	const filepath = await core.fs.saveDraft(task);

	if (await core.shouldAutoCommit(autoCommit)) {
		await core.git.addFile(filepath);
		await core.git.commitTaskChange(task.id, `Create draft ${task.id}`, filepath);
	}

	return filepath;
}

export async function updateTask(core: Core, task: Task, autoCommit?: boolean): Promise<void> {
	normalizeAssignee(task);

	const originalTask = await core.fs.loadTask(task.id);
	const oldStatus = originalTask?.status ?? "";
	const newStatus = task.status ?? "";
	const statusChanged = oldStatus !== newStatus;

	task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");

	await core.fs.saveTask(task);
	if (core.contentStore) {
		const savedTask = await core.fs.loadTask(task.id);
		if (savedTask) {
			core.contentStore.upsertTask(savedTask);
		}
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		const filePath = await getTaskPath(task.id, core);
		if (filePath) {
			await core.git.addAndCommitTaskFile(task.id, filePath, "update");
		}
	}

	if (statusChanged) {
		await executeStatusChangeCallback(core, task, oldStatus, newStatus);
	}
}

export async function updateTaskFromInput(
	core: Core,
	taskId: string,
	input: TaskUpdateInput,
	autoCommit?: boolean,
): Promise<Task> {
	const task = await core.fs.loadTask(taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}

	const requestedStatus = input.status?.trim().toLowerCase();
	if (requestedStatus === "draft") {
		return await demoteTaskWithUpdates(core, task, input, autoCommit);
	}

	const { mutated } = await applyTaskUpdateInput(
		task,
		input,
		async (status) => core.requireCanonicalStatus(status),
		core,
	);

	if (!mutated) {
		return task;
	}

	await updateTask(core, task, autoCommit);
	const refreshed = await core.fs.loadTask(taskId);
	return refreshed ?? task;
}

export async function updateDraft(core: Core, task: Task, autoCommit?: boolean): Promise<void> {
	task.status = "Draft";
	normalizeAssignee(task);
	task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");

	const filepath = await core.fs.saveDraft(task);

	if (await core.shouldAutoCommit(autoCommit)) {
		await core.git.addFile(filepath);
		await core.git.commitTaskChange(task.id, `Update draft ${task.id}`, filepath);
	}
}

export async function updateDraftFromInput(
	core: Core,
	draftId: string,
	input: TaskUpdateInput,
	autoCommit?: boolean,
): Promise<Task> {
	const draft = await core.fs.loadDraft(draftId);
	if (!draft) {
		throw new Error(`Draft not found: ${draftId}`);
	}

	const { mutated } = await applyTaskUpdateInput(
		draft,
		input,
		async (status) => {
			if (status.trim().toLowerCase() !== "draft") {
				throw new Error("Drafts must use status Draft.");
			}
			return "Draft";
		},
		core,
	);

	if (!mutated) {
		return draft;
	}

	await updateDraft(core, draft, autoCommit);
	const refreshed = await core.fs.loadDraft(draftId);
	return refreshed ?? draft;
}

export async function editTaskOrDraft(
	core: Core,
	taskId: string,
	input: TaskUpdateInput,
	autoCommit?: boolean,
): Promise<Task> {
	const draft = await core.fs.loadDraft(taskId);
	if (draft) {
		const requestedStatus = input.status?.trim();
		const wantsDraft = requestedStatus?.toLowerCase() === "draft";
		if (requestedStatus && !wantsDraft) {
			return await promoteDraftWithUpdates(core, draft, input, autoCommit);
		}
		return await updateDraftFromInput(core, draft.id, input, autoCommit);
	}

	const task = await core.fs.loadTask(taskId);
	if (!task) {
		throw new Error(`Task not found: ${taskId}`);
	}

	const requestedStatus = input.status?.trim();
	const wantsDraft = requestedStatus?.toLowerCase() === "draft";
	if (wantsDraft) {
		return await demoteTaskWithUpdates(core, task, input, autoCommit);
	}

	return await updateTaskFromInput(core, task.id, input, autoCommit);
}

async function promoteDraftWithUpdates(
	core: Core,
	draft: Task,
	input: TaskUpdateInput,
	autoCommit?: boolean,
): Promise<Task> {
	const targetStatus = input.status?.trim();
	if (!targetStatus || targetStatus.toLowerCase() === "draft") {
		throw new Error("Promoting a draft requires a non-draft status.");
	}

	const { mutated } = await applyTaskUpdateInput(
		draft,
		{ ...input, status: undefined },
		async (status) => {
			if (status.trim().toLowerCase() !== "draft") {
				throw new Error("Drafts must use status Draft.");
			}
			return "Draft";
		},
		core,
	);

	const canonicalStatus = await core.requireCanonicalStatus(targetStatus);
	const newTaskId = await core.generateNextId(EntityType.Task, draft.parentTaskId);
	const draftPath = draft.filePath;

	const promotedTask: Task = {
		...draft,
		id: newTaskId,
		status: canonicalStatus,
		filePath: undefined,
		...(mutated || draft.status !== canonicalStatus
			? { updatedDate: new Date().toISOString().slice(0, 16).replace("T", " ") }
			: {}),
	};

	normalizeAssignee(promotedTask);
	const savedPath = await core.fs.saveTask(promotedTask);

	if (draftPath) {
		await unlink(draftPath);
	}

	if (core.contentStore) {
		const savedTask = await core.fs.loadTask(promotedTask.id);
		if (savedTask) {
			core.contentStore.upsertTask(savedTask);
		}
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		const backlogDir = DEFAULT_DIRECTORIES.BACKLOG;
		const repoRoot = await core.git.stageBacklogDirectory(backlogDir);
		await core.git.commitChanges(`backlog: Promote draft ${normalizeId(draft.id, "draft")}`, repoRoot);
	}

	return (await core.fs.loadTask(promotedTask.id)) ?? { ...promotedTask, filePath: savedPath };
}

async function demoteTaskWithUpdates(
	core: Core,
	task: Task,
	input: TaskUpdateInput,
	autoCommit?: boolean,
): Promise<Task> {
	const { mutated } = await applyTaskUpdateInput(
		task,
		{ ...input, status: undefined },
		async (status) => {
			if (status.trim().toLowerCase() === "draft") {
				return "Draft";
			}
			return core.requireCanonicalStatus(status);
		},
		core,
	);

	const newDraftId = await core.generateNextId(EntityType.Draft);
	const taskPath = task.filePath;

	const demotedDraft: Task = {
		...task,
		id: newDraftId,
		status: "Draft",
		filePath: undefined,
		...(mutated || task.status !== "Draft"
			? { updatedDate: new Date().toISOString().slice(0, 16).replace("T", " ") }
			: {}),
	};

	normalizeAssignee(demotedDraft);
	const savedPath = await core.fs.saveDraft(demotedDraft);

	if (taskPath) {
		await unlink(taskPath);
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		const backlogDir = DEFAULT_DIRECTORIES.BACKLOG;
		const repoRoot = await core.git.stageBacklogDirectory(backlogDir);
		await core.git.commitChanges(`backlog: Demote task ${normalizeTaskId(task.id)}`, repoRoot);
	}

	return (await core.fs.loadDraft(demotedDraft.id)) ?? { ...demotedDraft, filePath: savedPath };
}

async function executeStatusChangeCallback(
	core: Core,
	task: Task,
	oldStatus: string,
	newStatus: string,
): Promise<void> {
	const config = await core.fs.loadConfig();

	const callbackCommand = task.onStatusChange ?? config?.onStatusChange;
	if (!callbackCommand) {
		return;
	}

	try {
		const result = await executeStatusCallback({
			command: callbackCommand,
			taskId: task.id,
			oldStatus,
			newStatus,
			taskTitle: task.title,
			cwd: core.fs.rootDir,
		});

		if (!result.success) {
			console.error(`Status change callback failed for ${task.id}: ${result.error ?? "Unknown error"}`);
			if (result.output) {
				console.error(`Callback output: ${result.output}`);
			}
		} else if (process.env.DEBUG && result.output) {
			console.log(`Status change callback output for ${task.id}: ${result.output}`);
		}
	} catch (error) {
		console.error(`Failed to execute status change callback for ${task.id}:`, error);
	}
}

export async function editTask(
	core: Core,
	taskId: string,
	input: TaskUpdateInput,
	autoCommit?: boolean,
): Promise<Task> {
	return await updateTaskFromInput(core, taskId, input, autoCommit);
}

export async function updateTasksBulk(
	core: Core,
	tasks: Task[],
	commitMessage?: string,
	autoCommit?: boolean,
): Promise<void> {
	for (const task of tasks) {
		await updateTask(core, task, false);
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		const backlogDir = DEFAULT_DIRECTORIES.BACKLOG;
		const repoRoot = await core.git.stageBacklogDirectory(backlogDir);
		await core.git.commitChanges(commitMessage || `Update ${tasks.length} tasks`, repoRoot);
	}
}

export async function reorderTask(
	core: Core,
	params: {
		taskId: string;
		targetStatus: string;
		orderedTaskIds: string[];
		targetMilestone?: string | null;
		commitMessage?: string;
		autoCommit?: boolean;
		defaultStep?: number;
	},
): Promise<{ updatedTask: Task; changedTasks: Task[] }> {
	const taskId = normalizeTaskId(String(params.taskId || "").trim());
	const targetStatus = String(params.targetStatus || "").trim();
	const orderedTaskIds = params.orderedTaskIds.map((id) => normalizeTaskId(String(id || "").trim())).filter(Boolean);
	const defaultStep = params.defaultStep ?? DEFAULT_ORDINAL_STEP;

	if (!taskId) throw new Error("taskId is required");
	if (!targetStatus) throw new Error("targetStatus is required");
	if (orderedTaskIds.length === 0) throw new Error("orderedTaskIds must include at least one task");
	if (!orderedTaskIds.includes(taskId)) {
		throw new Error("orderedTaskIds must include the task being moved");
	}

	const seen = new Set<string>();
	for (const id of orderedTaskIds) {
		if (seen.has(id)) {
			throw new Error(`Duplicate task id ${id} in orderedTaskIds`);
		}
		seen.add(id);
	}

	const loadedTasks = await Promise.all(
		orderedTaskIds.map(async (id) => {
			const task = await getTask(core, id);
			return task;
		}),
	);

	const validTasks = loadedTasks.filter((t): t is Task => t !== null);

	const movedTask = validTasks.find((t) => t.id === taskId);
	if (!movedTask) {
		throw new Error(`Task ${taskId} not found while reordering`);
	}

	if (movedTask.branch) {
		throw new Error(
			`Task ${taskId} exists in branch "${movedTask.branch}" and cannot be reordered from the current branch. Switch to that branch to modify it.`,
		);
	}

	const hasTargetMilestone = params.targetMilestone !== undefined;
	const normalizedTargetMilestone =
		params.targetMilestone === null
			? undefined
			: typeof params.targetMilestone === "string" && params.targetMilestone.trim().length > 0
				? params.targetMilestone.trim()
				: undefined;

	const validOrderedIds = orderedTaskIds.filter((id) => validTasks.some((t) => t.id === id));
	const targetIndex = validOrderedIds.indexOf(taskId);

	if (targetIndex === -1) {
		throw new Error("Implementation error: Task found in validTasks but index missing");
	}

	const previousTask = targetIndex > 0 ? validTasks[targetIndex - 1] : null;
	const nextTask = targetIndex < validTasks.length - 1 ? validTasks[targetIndex + 1] : null;

	const { ordinal: newOrdinal, requiresRebalance } = calculateNewOrdinal({
		previous: previousTask,
		next: nextTask,
		defaultStep,
	});

	const updatedMoved: Task = {
		...movedTask,
		status: targetStatus,
		...(hasTargetMilestone ? { milestone: normalizedTargetMilestone } : {}),
		ordinal: newOrdinal,
	};

	const tasksInOrder: Task[] = validTasks.map((task, index) => (index === targetIndex ? updatedMoved : task));
	const resolutionUpdates = resolveOrdinalConflicts(tasksInOrder, {
		defaultStep,
		startOrdinal: defaultStep,
		forceSequential: requiresRebalance,
	});

	const updatesMap = new Map<string, Task>();
	for (const update of resolutionUpdates) {
		updatesMap.set(update.id, update);
	}
	if (!updatesMap.has(updatedMoved.id)) {
		updatesMap.set(updatedMoved.id, updatedMoved);
	}

	const originalMap = new Map(validTasks.map((task) => [task.id, task]));
	const changedTasks = Array.from(updatesMap.values()).filter((task) => {
		const original = originalMap.get(task.id);
		if (!original) return true;
		return (
			(original.ordinal ?? null) !== (task.ordinal ?? null) ||
			(original.status ?? "") !== (task.status ?? "") ||
			(original.milestone ?? "") !== (task.milestone ?? "")
		);
	});

	if (changedTasks.length > 0) {
		await updateTasksBulk(
			core,
			changedTasks,
			params.commitMessage ?? `Reorder tasks in ${targetStatus}`,
			params.autoCommit,
		);
	}

	const updatedTask = updatesMap.get(taskId) ?? updatedMoved;
	return { updatedTask, changedTasks };
}

export async function listActiveSequences(core: Core): Promise<{ unsequenced: Task[]; sequences: Sequence[] }> {
	const all = await core.fs.listTasks();
	const active = all.filter((t) => (t.status || "").toLowerCase() !== "done");
	return computeSequences(active);
}

export async function moveTaskInSequences(
	core: Core,
	params: {
		taskId: string;
		unsequenced?: boolean;
		targetSequenceIndex?: number;
	},
): Promise<{ unsequenced: Task[]; sequences: Sequence[] }> {
	const taskId = String(params.taskId || "").trim();
	if (!taskId) throw new Error("taskId is required");

	const allTasks = await core.fs.listTasks();
	const exists = allTasks.some((t) => t.id === taskId);
	if (!exists) throw new Error(`Task ${taskId} not found`);

	const active = allTasks.filter((t) => (t.status || "").toLowerCase() !== "done");
	const { sequences } = computeSequences(active);

	if (params.unsequenced) {
		const res = planMoveToUnsequenced(allTasks, taskId);
		if (!res.ok) throw new Error(res.error);
		await updateTasksBulk(core, res.changed, `Move ${taskId} to Unsequenced`);
	} else {
		const targetSequenceIndex = params.targetSequenceIndex;
		if (targetSequenceIndex === undefined || Number.isNaN(targetSequenceIndex)) {
			throw new Error("targetSequenceIndex must be a number");
		}
		if (targetSequenceIndex < 1) throw new Error("targetSequenceIndex must be >= 1");
		const changed = planMoveToSequence(allTasks, sequences, taskId, targetSequenceIndex);
		if (changed.length > 0) await updateTasksBulk(core, changed, `Update deps/order for ${taskId}`);
	}

	const afterAll = await core.fs.listTasks();
	const afterActive = afterAll.filter((t) => (t.status || "").toLowerCase() !== "done");
	return computeSequences(afterActive);
}
