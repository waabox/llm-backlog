import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES, DEFAULT_STATUSES, FALLBACK_STATUS } from "../constants/index.ts";
import { FileSystem } from "../file-system/operations.ts";
import { GitOperations } from "../git/operations.ts";
import {
	type AcceptanceCriterion,
	type BacklogConfig,
	type Decision,
	type Document,
	EntityType,
	type Milestone,
	type Sequence,
	type Task,
	type TaskCreateInput,
	type TaskUpdateInput,
} from "../types/index.ts";
import { normalizeAssignee } from "../utils/assignee.ts";
import { openInEditor } from "../utils/editor.ts";
import { normalizeId } from "../utils/prefix-config.ts";
import {
	getCanonicalStatus as resolveCanonicalStatus,
	getValidStatuses as resolveValidStatuses,
} from "../utils/status.ts";
import { executeStatusCallback } from "../utils/status-callback.ts";
import {
	buildDefinitionOfDoneItems,
	normalizeDependencies,
	normalizeStringList,
	validateDependencies,
} from "../utils/task-builders.ts";
import { getTaskPath, normalizeTaskId } from "../utils/task-path.ts";
import {
	addAcceptanceCriteria,
	checkAcceptanceCriteria,
	listAcceptanceCriteria,
	removeAcceptanceCriteria,
} from "./acceptance-criteria.ts";
import {
	archiveDraft,
	archiveMilestone,
	archiveTask,
	completeTask,
	demoteTask,
	getDoneTasksByAge,
	promoteDraft,
	renameMilestone,
} from "./archive-service.ts";
import {
	extractLegacyConfigMilestones,
	migrateConfig,
	migrateLegacyConfigMilestonesToFiles,
	needsMigration,
} from "./config-migration.ts";
import { ContentStore } from "./content-store.ts";
import {
	createDecision,
	createDecisionWithTitle,
	createDocument,
	createDocumentWithId,
	getDocument,
	getDocumentContent,
	updateDecisionFromContent,
	updateDocument,
} from "./entity-service.ts";
import { generateNextId } from "./id-generation.ts";
import { migrateDraftPrefixes, needsDraftPrefixMigration } from "./prefix-migration.ts";
import { calculateNewOrdinal, DEFAULT_ORDINAL_STEP, resolveOrdinalConflicts } from "./reorder.ts";
import { SearchService } from "./search-service.ts";
import { computeSequences, planMoveToSequence, planMoveToUnsequenced } from "./sequences.ts";
import { applyTaskUpdateInput, normalizePriority } from "./task-mutation.ts";
import {
	getTask,
	getTaskContent,
	getTaskWithSubtasks,
	listTasksWithMetadata,
	loadAllTasksForStatistics,
	loadTaskById,
	loadTasks,
	queryTasks,
	type TaskQueryOptions,
} from "./task-query.ts";

interface BlessedScreen {
	program: {
		disableMouse(): void;
		enableMouse(): void;
		hideCursor(): void;
		showCursor(): void;
		input: NodeJS.EventEmitter;
		pause?: () => (() => void) | undefined;
		flush?: () => void;
		put?: {
			keypad_local?: () => void;
			keypad_xmit?: () => void;
		};
	};
	leave(): void;
	enter(): void;
	render(): void;
	clearRegion(x1: number, x2: number, y1: number, y2: number): void;
	width: number;
	height: number;
	emit(event: string): void;
}

export class Core {
	public fs: FileSystem;
	public git: GitOperations;
	private contentStore?: ContentStore;
	private searchService?: SearchService;
	private readonly enableWatchers: boolean;

	constructor(projectRoot: string, options?: { enableWatchers?: boolean }) {
		this.fs = new FileSystem(projectRoot);
		this.git = new GitOperations(projectRoot);
		// Disable watchers by default for CLI commands (non-interactive)
		// Interactive modes (TUI, browser, MCP) should explicitly pass enableWatchers: true
		this.enableWatchers = options?.enableWatchers ?? false;
		// Note: Config is loaded lazily when needed since constructor can't be async
	}

	async getContentStore(): Promise<ContentStore> {
		if (!this.contentStore) {
			// Use loadTasks as the task loader to include cross-branch tasks
			this.contentStore = new ContentStore(this.fs, () => this.loadTasks(), this.enableWatchers);
		}
		await this.contentStore.ensureInitialized();
		return this.contentStore;
	}

	async getSearchService(): Promise<SearchService> {
		if (!this.searchService) {
			const store = await this.getContentStore();
			this.searchService = new SearchService(store);
		}
		await this.searchService.ensureInitialized();
		return this.searchService;
	}

	private async requireCanonicalStatus(status: string): Promise<string> {
		const canonical = await resolveCanonicalStatus(status, this);
		if (canonical) {
			return canonical;
		}
		const validStatuses = await resolveValidStatuses(this);
		throw new Error(`Invalid status: ${status}. Valid statuses are: ${validStatuses.join(", ")}`);
	}

	async queryTasks(options: TaskQueryOptions = {}): Promise<Task[]> {
		return queryTasks(this, options);
	}

	async getTask(taskId: string): Promise<Task | null> {
		return getTask(this, taskId);
	}

	async getTaskWithSubtasks(taskId: string, localTasks?: Task[]): Promise<Task | null> {
		return getTaskWithSubtasks(this, taskId, localTasks);
	}

	async loadTaskById(taskId: string): Promise<Task | null> {
		return loadTaskById(this, taskId);
	}

	async getTaskContent(taskId: string): Promise<string | null> {
		return getTaskContent(this, taskId);
	}

	async getDocument(documentId: string): Promise<Document | null> {
		return getDocument(this, documentId);
	}

	async getDocumentContent(documentId: string): Promise<string | null> {
		return getDocumentContent(this, documentId);
	}

	disposeSearchService(): void {
		if (this.searchService) {
			this.searchService.dispose();
			this.searchService = undefined;
		}
	}

	disposeContentStore(): void {
		if (this.contentStore) {
			this.contentStore.dispose();
			this.contentStore = undefined;
		}
	}

	// Backward compatibility aliases
	get filesystem() {
		return this.fs;
	}

	get gitOps() {
		return this.git;
	}

	async ensureConfigLoaded(): Promise<void> {
		try {
			const config = await this.fs.loadConfig();
			this.git.setConfig(config);
		} catch (error) {
			// Config loading failed, git operations will work with null config
			if (process.env.DEBUG) {
				console.warn("Failed to load config for git operations:", error);
			}
		}
	}

	private async getBacklogDirectoryName(): Promise<string> {
		// Always use "backlog" as the directory name
		return DEFAULT_DIRECTORIES.BACKLOG;
	}

	async shouldAutoCommit(overrideValue?: boolean): Promise<boolean> {
		// If override is explicitly provided, use it
		if (overrideValue !== undefined) {
			return overrideValue;
		}
		// Otherwise, check config (default to false for safety)
		const config = await this.fs.loadConfig();
		return config?.autoCommit ?? false;
	}

	async getGitOps() {
		await this.ensureConfigLoaded();
		return this.git;
	}

	async ensureConfigMigrated(): Promise<void> {
		await this.ensureConfigLoaded();
		const legacyMilestones = await extractLegacyConfigMilestones(join(this.fs.rootDir, DEFAULT_DIRECTORIES.BACKLOG));
		let config = await this.fs.loadConfig();
		const needsSchemaMigration = !config || needsMigration(config);

		if (needsSchemaMigration) {
			config = migrateConfig(config || {});
		}
		if (legacyMilestones.length > 0) {
			await migrateLegacyConfigMilestonesToFiles(legacyMilestones, this.fs);
		}
		if (config && (needsSchemaMigration || legacyMilestones.length > 0)) {
			// Rewrite config to apply schema defaults and strip legacy milestones key after successful migration.
			await this.fs.saveConfig(config);
		}

		// Run draft prefix migration if needed (one-time migration)
		// This renames task-*.md files in drafts/ to draft-*.md
		if (needsDraftPrefixMigration(config)) {
			await migrateDraftPrefixes(this.fs);
		}
	}

	// ID generation
	/**
	 * Generates the next ID for a given entity type.
	 *
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
	async generateNextId(type: EntityType = EntityType.Task, parent?: string): Promise<string> {
		return generateNextId(this, type, parent);
	}

	// High-level operations that combine filesystem and git
	async createTaskFromData(
		taskData: {
			title: string;
			status?: string;
			assignee?: string[];
			labels?: string[];
			dependencies?: string[];
			parentTaskId?: string;
			priority?: "high" | "medium" | "low";
			// First-party structured fields from Web UI / CLI
			description?: string;
			acceptanceCriteriaItems?: import("../types/index.ts").AcceptanceCriterion[];
			implementationPlan?: string;
			implementationNotes?: string;
			finalSummary?: string;
			milestone?: string;
		},
		autoCommit?: boolean,
	): Promise<Task> {
		// Determine entity type before generating ID - drafts get DRAFT-X, tasks get TASK-X
		const isDraft = taskData.status?.toLowerCase() === "draft";
		const entityType = isDraft ? EntityType.Draft : EntityType.Task;
		const id = await this.generateNextId(entityType, isDraft ? undefined : taskData.parentTaskId);

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
			...(Array.isArray(taskData.acceptanceCriteriaItems) &&
				taskData.acceptanceCriteriaItems.length > 0 && {
					acceptanceCriteriaItems: taskData.acceptanceCriteriaItems,
				}),
			...(typeof taskData.implementationPlan === "string" && { implementationPlan: taskData.implementationPlan }),
			...(typeof taskData.implementationNotes === "string" && { implementationNotes: taskData.implementationNotes }),
			...(typeof taskData.finalSummary === "string" && { finalSummary: taskData.finalSummary }),
		};

		// Save as draft or task based on status
		if (isDraft) {
			await this.createDraft(task, autoCommit);
		} else {
			await this.createTask(task, autoCommit);
		}

		return task;
	}

	async createTaskFromInput(input: TaskCreateInput, autoCommit?: boolean): Promise<{ task: Task; filePath?: string }> {
		if (!input.title || input.title.trim().length === 0) {
			throw new Error("Title is required to create a task.");
		}

		// Determine if this is a draft BEFORE generating the ID
		const requestedStatus = input.status?.trim();
		const isDraft = requestedStatus?.toLowerCase() === "draft";

		// Generate ID with appropriate entity type - drafts get DRAFT-X, tasks get TASK-X
		const entityType = isDraft ? EntityType.Draft : EntityType.Task;
		const id = await this.generateNextId(entityType, isDraft ? undefined : input.parentTaskId);

		const normalizedLabels = normalizeStringList(input.labels) ?? [];
		const normalizedAssignees = normalizeStringList(input.assignee) ?? [];
		const normalizedDependencies = normalizeDependencies(input.dependencies);
		const normalizedReferences = normalizeStringList(input.references) ?? [];
		const normalizedDocumentation = normalizeStringList(input.documentation) ?? [];

		const { valid: validDependencies, invalid: invalidDependencies } = await validateDependencies(
			normalizedDependencies,
			this,
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
				status = await this.requireCanonicalStatus(requestedStatus);
			}
		}

		const priority = normalizePriority(input.priority);
		const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");

		const acceptanceCriteriaItems = Array.isArray(input.acceptanceCriteria)
			? input.acceptanceCriteria
					.map((criterion, index) => ({
						index: index + 1,
						text: String(criterion.text ?? "").trim(),
						checked: Boolean(criterion.checked),
					}))
					.filter((criterion) => criterion.text.length > 0)
			: [];
		const config = await this.fs.loadConfig();
		const definitionOfDoneItems = buildDefinitionOfDoneItems({
			defaults: config?.definitionOfDone,
			add: input.definitionOfDoneAdd,
			disableDefaults: input.disableDefinitionOfDoneDefaults,
		});

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
			...(typeof input.implementationNotes === "string" && { implementationNotes: input.implementationNotes }),
			...(typeof input.finalSummary === "string" && { finalSummary: input.finalSummary }),
			...(acceptanceCriteriaItems.length > 0 && { acceptanceCriteriaItems }),
			...(definitionOfDoneItems && definitionOfDoneItems.length > 0 && { definitionOfDoneItems }),
		};

		const filePath = isDraft ? await this.createDraft(task, autoCommit) : await this.createTask(task, autoCommit);

		// Load the saved task/draft to return updated data
		const savedTask = isDraft ? await this.fs.loadDraft(id) : await this.fs.loadTask(id);
		return { task: savedTask ?? task, filePath };
	}

	async createTask(task: Task, autoCommit?: boolean): Promise<string> {
		if (!task.status) {
			const config = await this.fs.loadConfig();
			task.status = config?.defaultStatus || FALLBACK_STATUS;
		}

		normalizeAssignee(task);

		const filepath = await this.fs.saveTask(task);
		// Keep any in-process ContentStore in sync for immediate UI/search freshness.
		if (this.contentStore) {
			const savedTask = await this.fs.loadTask(task.id);
			if (savedTask) {
				this.contentStore.upsertTask(savedTask);
			}
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addAndCommitTaskFile(task.id, filepath, "create");
		}

		return filepath;
	}

	async createDraft(task: Task, autoCommit?: boolean): Promise<string> {
		// Drafts always have status "Draft", regardless of config default
		task.status = "Draft";
		normalizeAssignee(task);

		const filepath = await this.fs.saveDraft(task);

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addFile(filepath);
			await this.git.commitTaskChange(task.id, `Create draft ${task.id}`, filepath);
		}

		return filepath;
	}

	async updateTask(task: Task, autoCommit?: boolean): Promise<void> {
		normalizeAssignee(task);

		// Load original task to detect status changes for callbacks
		const originalTask = await this.fs.loadTask(task.id);
		const oldStatus = originalTask?.status ?? "";
		const newStatus = task.status ?? "";
		const statusChanged = oldStatus !== newStatus;

		// Always set updatedDate when updating a task
		task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");

		await this.fs.saveTask(task);
		// Keep any in-process ContentStore in sync for immediate UI/search freshness.
		if (this.contentStore) {
			const savedTask = await this.fs.loadTask(task.id);
			if (savedTask) {
				this.contentStore.upsertTask(savedTask);
			}
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			const filePath = await getTaskPath(task.id, this);
			if (filePath) {
				await this.git.addAndCommitTaskFile(task.id, filePath, "update");
			}
		}

		// Fire status change callback if status changed
		if (statusChanged) {
			await this.executeStatusChangeCallback(task, oldStatus, newStatus);
		}
	}

	async updateTaskFromInput(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		const task = await this.fs.loadTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const requestedStatus = input.status?.trim().toLowerCase();
		if (requestedStatus === "draft") {
			return await this.demoteTaskWithUpdates(task, input, autoCommit);
		}

		const { mutated } = await applyTaskUpdateInput(
			task,
			input,
			async (status) => this.requireCanonicalStatus(status),
			this,
		);

		if (!mutated) {
			return task;
		}

		await this.updateTask(task, autoCommit);
		const refreshed = await this.fs.loadTask(taskId);
		return refreshed ?? task;
	}

	async updateDraft(task: Task, autoCommit?: boolean): Promise<void> {
		// Drafts always keep status Draft
		task.status = "Draft";
		normalizeAssignee(task);
		task.updatedDate = new Date().toISOString().slice(0, 16).replace("T", " ");

		const filepath = await this.fs.saveDraft(task);

		if (await this.shouldAutoCommit(autoCommit)) {
			await this.git.addFile(filepath);
			await this.git.commitTaskChange(task.id, `Update draft ${task.id}`, filepath);
		}
	}

	async updateDraftFromInput(draftId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		const draft = await this.fs.loadDraft(draftId);
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
			this,
		);

		if (!mutated) {
			return draft;
		}

		await this.updateDraft(draft, autoCommit);
		const refreshed = await this.fs.loadDraft(draftId);
		return refreshed ?? draft;
	}

	async editTaskOrDraft(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		const draft = await this.fs.loadDraft(taskId);
		if (draft) {
			const requestedStatus = input.status?.trim();
			const wantsDraft = requestedStatus?.toLowerCase() === "draft";
			if (requestedStatus && !wantsDraft) {
				return await this.promoteDraftWithUpdates(draft, input, autoCommit);
			}
			return await this.updateDraftFromInput(draft.id, input, autoCommit);
		}

		const task = await this.fs.loadTask(taskId);
		if (!task) {
			throw new Error(`Task not found: ${taskId}`);
		}

		const requestedStatus = input.status?.trim();
		const wantsDraft = requestedStatus?.toLowerCase() === "draft";
		if (wantsDraft) {
			return await this.demoteTaskWithUpdates(task, input, autoCommit);
		}

		return await this.updateTaskFromInput(task.id, input, autoCommit);
	}

	private async promoteDraftWithUpdates(draft: Task, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
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
			this,
		);

		const canonicalStatus = await this.requireCanonicalStatus(targetStatus);
		const newTaskId = await this.generateNextId(EntityType.Task, draft.parentTaskId);
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
		const savedPath = await this.fs.saveTask(promotedTask);

		if (draftPath) {
			await unlink(draftPath);
		}

		if (this.contentStore) {
			const savedTask = await this.fs.loadTask(promotedTask.id);
			if (savedTask) {
				this.contentStore.upsertTask(savedTask);
			}
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			const backlogDir = await this.getBacklogDirectoryName();
			const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
			await this.git.commitChanges(`backlog: Promote draft ${normalizeId(draft.id, "draft")}`, repoRoot);
		}

		return (await this.fs.loadTask(promotedTask.id)) ?? { ...promotedTask, filePath: savedPath };
	}

	private async demoteTaskWithUpdates(task: Task, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		const { mutated } = await applyTaskUpdateInput(
			task,
			{ ...input, status: undefined },
			async (status) => {
				if (status.trim().toLowerCase() === "draft") {
					return "Draft";
				}
				return this.requireCanonicalStatus(status);
			},
			this,
		);

		const newDraftId = await this.generateNextId(EntityType.Draft);
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
		const savedPath = await this.fs.saveDraft(demotedDraft);

		if (taskPath) {
			await unlink(taskPath);
		}

		if (await this.shouldAutoCommit(autoCommit)) {
			const backlogDir = await this.getBacklogDirectoryName();
			const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
			await this.git.commitChanges(`backlog: Demote task ${normalizeTaskId(task.id)}`, repoRoot);
		}

		return (await this.fs.loadDraft(demotedDraft.id)) ?? { ...demotedDraft, filePath: savedPath };
	}

	/**
	 * Execute the onStatusChange callback if configured.
	 * Per-task callback takes precedence over global config.
	 * Failures are logged but don't block the status change.
	 */
	private async executeStatusChangeCallback(task: Task, oldStatus: string, newStatus: string): Promise<void> {
		const config = await this.fs.loadConfig();

		// Per-task callback takes precedence over global config
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
				cwd: this.fs.rootDir,
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

	async editTask(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		return await this.updateTaskFromInput(taskId, input, autoCommit);
	}

	async updateTasksBulk(tasks: Task[], commitMessage?: string, autoCommit?: boolean): Promise<void> {
		// Update all tasks without committing individually
		for (const task of tasks) {
			await this.updateTask(task, false); // Don't auto-commit each one
		}

		// Commit all changes at once if auto-commit is enabled
		if (await this.shouldAutoCommit(autoCommit)) {
			const backlogDir = await this.getBacklogDirectoryName();
			const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
			await this.git.commitChanges(commitMessage || `Update ${tasks.length} tasks`, repoRoot);
		}
	}

	async reorderTask(params: {
		taskId: string;
		targetStatus: string;
		orderedTaskIds: string[];
		targetMilestone?: string | null;
		commitMessage?: string;
		autoCommit?: boolean;
		defaultStep?: number;
	}): Promise<{ updatedTask: Task; changedTasks: Task[] }> {
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

		// Load all tasks from the ordered list - use getTask to include cross-branch tasks from the store
		const loadedTasks = await Promise.all(
			orderedTaskIds.map(async (id) => {
				const task = await this.getTask(id);
				return task;
			}),
		);

		// Filter out any tasks that couldn't be loaded (may have been moved/deleted)
		const validTasks = loadedTasks.filter((t): t is Task => t !== null);

		// Verify the moved task itself exists
		const movedTask = validTasks.find((t) => t.id === taskId);
		if (!movedTask) {
			throw new Error(`Task ${taskId} not found while reordering`);
		}

		// Reject reordering tasks from other branches - they can only be modified in their source branch
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

		// Calculate target index within the valid tasks list
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
			await this.updateTasksBulk(
				changedTasks,
				params.commitMessage ?? `Reorder tasks in ${targetStatus}`,
				params.autoCommit,
			);
		}

		const updatedTask = updatesMap.get(taskId) ?? updatedMoved;
		return { updatedTask, changedTasks };
	}

	// Sequences operations (business logic lives in core, not server)
	async listActiveSequences(): Promise<{ unsequenced: Task[]; sequences: Sequence[] }> {
		const all = await this.fs.listTasks();
		const active = all.filter((t) => (t.status || "").toLowerCase() !== "done");
		return computeSequences(active);
	}

	async moveTaskInSequences(params: {
		taskId: string;
		unsequenced?: boolean;
		targetSequenceIndex?: number;
	}): Promise<{ unsequenced: Task[]; sequences: Sequence[] }> {
		const taskId = String(params.taskId || "").trim();
		if (!taskId) throw new Error("taskId is required");

		const allTasks = await this.fs.listTasks();
		const exists = allTasks.some((t) => t.id === taskId);
		if (!exists) throw new Error(`Task ${taskId} not found`);

		const active = allTasks.filter((t) => (t.status || "").toLowerCase() !== "done");
		const { sequences } = computeSequences(active);

		if (params.unsequenced) {
			const res = planMoveToUnsequenced(allTasks, taskId);
			if (!res.ok) throw new Error(res.error);
			await this.updateTasksBulk(res.changed, `Move ${taskId} to Unsequenced`);
		} else {
			const targetSequenceIndex = params.targetSequenceIndex;
			if (targetSequenceIndex === undefined || Number.isNaN(targetSequenceIndex)) {
				throw new Error("targetSequenceIndex must be a number");
			}
			if (targetSequenceIndex < 1) throw new Error("targetSequenceIndex must be >= 1");
			const changed = planMoveToSequence(allTasks, sequences, taskId, targetSequenceIndex);
			if (changed.length > 0) await this.updateTasksBulk(changed, `Update deps/order for ${taskId}`);
		}

		// Return updated sequences
		const afterAll = await this.fs.listTasks();
		const afterActive = afterAll.filter((t) => (t.status || "").toLowerCase() !== "done");
		return computeSequences(afterActive);
	}

	async archiveTask(taskId: string, autoCommit?: boolean): Promise<boolean> {
		return archiveTask(this, taskId, autoCommit);
	}

	async archiveMilestone(
		identifier: string,
		autoCommit?: boolean,
	): Promise<{ success: boolean; sourcePath?: string; targetPath?: string; milestone?: Milestone }> {
		return archiveMilestone(this, identifier, autoCommit);
	}

	async renameMilestone(
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
		return renameMilestone(this, identifier, title, autoCommit);
	}

	async completeTask(taskId: string, autoCommit?: boolean): Promise<boolean> {
		return completeTask(this, taskId, autoCommit);
	}

	async getDoneTasksByAge(olderThanDays: number): Promise<Task[]> {
		return getDoneTasksByAge(this, olderThanDays);
	}

	async archiveDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
		return archiveDraft(this, draftId, autoCommit);
	}

	async promoteDraft(draftId: string, autoCommit?: boolean): Promise<boolean> {
		return promoteDraft(this, draftId, autoCommit);
	}

	async demoteTask(taskId: string, autoCommit?: boolean): Promise<boolean> {
		return demoteTask(this, taskId, autoCommit);
	}

	/**
	 * Add acceptance criteria to a task
	 */
	async addAcceptanceCriteria(taskId: string, criteria: string[], autoCommit?: boolean): Promise<void> {
		return addAcceptanceCriteria(this, taskId, criteria, autoCommit);
	}

	/**
	 * Remove acceptance criteria by indices (supports batch operations)
	 * @returns Array of removed indices
	 */
	async removeAcceptanceCriteria(taskId: string, indices: number[], autoCommit?: boolean): Promise<number[]> {
		return removeAcceptanceCriteria(this, taskId, indices, autoCommit);
	}

	/**
	 * Check or uncheck acceptance criteria by indices (supports batch operations)
	 * Silently ignores invalid indices and only updates valid ones.
	 * @returns Array of updated indices
	 */
	async checkAcceptanceCriteria(
		taskId: string,
		indices: number[],
		checked: boolean,
		autoCommit?: boolean,
	): Promise<number[]> {
		return checkAcceptanceCriteria(this, taskId, indices, checked, autoCommit);
	}

	/**
	 * List all acceptance criteria for a task
	 */
	async listAcceptanceCriteria(taskId: string): Promise<AcceptanceCriterion[]> {
		return listAcceptanceCriteria(this, taskId);
	}

	async createDecision(decision: Decision, autoCommit?: boolean): Promise<void> {
		return createDecision(this, decision, autoCommit);
	}

	async updateDecisionFromContent(decisionId: string, content: string, autoCommit?: boolean): Promise<void> {
		return updateDecisionFromContent(this, decisionId, content, autoCommit);
	}

	async createDecisionWithTitle(title: string, autoCommit?: boolean): Promise<Decision> {
		return createDecisionWithTitle(this, title, autoCommit);
	}

	async createDocument(doc: Document, autoCommit?: boolean, subPath = ""): Promise<void> {
		return createDocument(this, doc, autoCommit, subPath);
	}

	async updateDocument(existingDoc: Document, content: string, autoCommit?: boolean): Promise<void> {
		return updateDocument(this, existingDoc, content, autoCommit);
	}

	async createDocumentWithId(title: string, content: string, autoCommit?: boolean): Promise<Document> {
		return createDocumentWithId(this, title, content, autoCommit);
	}

	async initializeProject(projectName: string, autoCommit = false): Promise<void> {
		await this.fs.ensureBacklogStructure();

		const config: BacklogConfig = {
			projectName: projectName,
			statuses: [...DEFAULT_STATUSES],
			labels: [],
			defaultStatus: DEFAULT_STATUSES[0], // Use first status as default
			dateFormat: "yyyy-mm-dd",
			maxColumnWidth: 20, // Default for terminal display
			autoCommit: false, // Default to false for user control
			prefixes: {
				task: "task",
			},
		};

		await this.fs.saveConfig(config);
		// Update git operations with the new config
		await this.ensureConfigLoaded();

		if (autoCommit) {
			const backlogDir = await this.getBacklogDirectoryName();
			const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
			await this.git.commitChanges(`backlog: Initialize backlog project: ${projectName}`, repoRoot);
		}
	}

	async listTasksWithMetadata(
		includeBranchMeta = false,
	): Promise<Array<Task & { lastModified?: Date; branch?: string }>> {
		return listTasksWithMetadata(this, includeBranchMeta);
	}

	/**
	 * Open a file in the configured editor with minimal interference
	 * @param filePath - Path to the file to edit
	 * @param screen - Optional blessed screen to suspend (for TUI contexts)
	 */
	async openEditor(filePath: string, screen?: BlessedScreen): Promise<boolean> {
		const config = await this.fs.loadConfig();

		// If no screen provided, use simple editor opening
		if (!screen) {
			return await openInEditor(filePath, config);
		}

		const program = screen.program;

		// Leave alternate screen buffer FIRST
		screen.leave();

		// Reset keypad/cursor mode using terminfo if available
		if (typeof program.put?.keypad_local === "function") {
			program.put.keypad_local();
			if (typeof program.flush === "function") {
				program.flush();
			}
		}

		// Send escape sequences directly as reinforcement
		// ESC[0m   = Reset all SGR attributes (fixes white background in nano)
		// ESC[?25h = Show cursor (ensure cursor is visible)
		// ESC[?1l  = Reset DECCKM (cursor keys send CSI sequences)
		// ESC>     = DECKPNM (numeric keypad mode)
		const fs = await import("node:fs");
		fs.writeSync(1, "\u001b[0m\u001b[?25h\u001b[?1l\u001b>");

		// Pause the terminal AFTER leaving alt buffer (disables raw mode, releases terminal)
		const resume = typeof program.pause === "function" ? program.pause() : undefined;
		try {
			return await openInEditor(filePath, config);
		} finally {
			// Resume terminal state FIRST (re-enables raw mode)
			if (typeof resume === "function") {
				resume();
			}
			// Re-enter alternate screen buffer
			screen.enter();
			// Restore application cursor mode
			if (typeof program.put?.keypad_xmit === "function") {
				program.put.keypad_xmit();
				if (typeof program.flush === "function") {
					program.flush();
				}
			}
			// Full redraw
			screen.render();
		}
	}

	/**
	 * Load and process all tasks with the same logic as CLI overview
	 * This method extracts the common task loading logic for reuse
	 */
	async loadAllTasksForStatistics(
		progressCallback?: (msg: string) => void,
	): Promise<{ tasks: Task[]; drafts: Task[]; statuses: string[] }> {
		return loadAllTasksForStatistics(this, progressCallback);
	}

	/**
	 * Load all tasks with cross-branch support
	 * This is the single entry point for loading tasks across all interfaces
	 */
	async loadTasks(
		progressCallback?: (msg: string) => void,
		abortSignal?: AbortSignal,
		options?: { includeCompleted?: boolean },
	): Promise<Task[]> {
		return loadTasks(this, progressCallback, abortSignal, options);
	}
}
