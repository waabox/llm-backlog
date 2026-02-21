import { join } from "node:path";
import { DEFAULT_DIRECTORIES, DEFAULT_STATUSES } from "../constants/index.ts";
import type { FileSystem } from "../file-system/operations.ts";
import { StorageCoordinator } from "../file-system/storage-coordinator.ts";
import { GitOperations } from "../git/operations.ts";
import {
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
import { openInEditor } from "../utils/editor.ts";
import {
	getCanonicalStatus as resolveCanonicalStatus,
	getValidStatuses as resolveValidStatuses,
} from "../utils/status.ts";
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
import { SearchService } from "./search-service.ts";
import {
	createDraft,
	createTask,
	createTaskFromData,
	createTaskFromInput,
	editTask,
	editTaskOrDraft,
	listActiveSequences,
	moveTaskInSequences,
	reorderTask,
	updateDraft,
	updateDraftFromInput,
	updateTask,
	updateTaskFromInput,
	updateTasksBulk,
} from "./task-lifecycle.ts";
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
	contentStore?: ContentStore;
	private searchService?: SearchService;
	private readonly enableWatchers: boolean;
	private autoCommitOverride: boolean | null = null;

	constructor(
		projectRoot: string,
		options?: {
			enableWatchers?: boolean;
			filesystem?: FileSystem;
			gitOperations?: GitOperations;
		},
	) {
		this.fs = options?.filesystem ?? new StorageCoordinator(projectRoot);
		this.git = options?.gitOperations ?? new GitOperations(projectRoot);
		// Disable watchers by default for CLI commands (non-interactive)
		// Interactive modes (TUI, browser, MCP) should explicitly pass enableWatchers: true
		this.enableWatchers = options?.enableWatchers ?? false;
		// Note: Config is loaded lazily when needed since constructor can't be async
	}

	/**
	 * Overrides the auto-commit setting from config for this Core instance.
	 * Used by BacklogServer when running with a remote project repo to ensure
	 * every task mutation is committed and pushed.
	 */
	setAutoCommitOverride(value: boolean): void {
		this.autoCommitOverride = value;
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

	async requireCanonicalStatus(status: string): Promise<string> {
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
		// Instance-level override takes precedence over config
		if (this.autoCommitOverride !== null) {
			return this.autoCommitOverride;
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
		if (this.fs instanceof StorageCoordinator && type !== EntityType.Document && !parent) {
			return this.fs.nextId(type);
		}
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
			implementationPlan?: string;
			finalSummary?: string;
			milestone?: string;
		},
		autoCommit?: boolean,
	): Promise<Task> {
		return createTaskFromData(this, taskData, autoCommit);
	}

	async createTaskFromInput(input: TaskCreateInput, autoCommit?: boolean): Promise<{ task: Task; filePath?: string }> {
		return createTaskFromInput(this, input, autoCommit);
	}

	async createTask(task: Task, autoCommit?: boolean): Promise<string> {
		return createTask(this, task, autoCommit);
	}

	async createDraft(task: Task, autoCommit?: boolean): Promise<string> {
		return createDraft(this, task, autoCommit);
	}

	async updateTask(task: Task, autoCommit?: boolean): Promise<void> {
		return updateTask(this, task, autoCommit);
	}

	async updateTaskFromInput(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		return updateTaskFromInput(this, taskId, input, autoCommit);
	}

	async updateDraft(task: Task, autoCommit?: boolean): Promise<void> {
		return updateDraft(this, task, autoCommit);
	}

	async updateDraftFromInput(draftId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		return updateDraftFromInput(this, draftId, input, autoCommit);
	}

	async editTaskOrDraft(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		return editTaskOrDraft(this, taskId, input, autoCommit);
	}

	async editTask(taskId: string, input: TaskUpdateInput, autoCommit?: boolean): Promise<Task> {
		return editTask(this, taskId, input, autoCommit);
	}

	async updateTasksBulk(tasks: Task[], commitMessage?: string, autoCommit?: boolean): Promise<void> {
		return updateTasksBulk(this, tasks, commitMessage, autoCommit);
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
		return reorderTask(this, params);
	}

	// Sequences operations (business logic lives in core, not server)
	async listActiveSequences(): Promise<{ unsequenced: Task[]; sequences: Sequence[] }> {
		return listActiveSequences(this);
	}

	async moveTaskInSequences(params: {
		taskId: string;
		unsequenced?: boolean;
		targetSequenceIndex?: number;
	}): Promise<{ unsequenced: Task[]; sequences: Sequence[] }> {
		return moveTaskInSequences(this, params);
	}

	async archiveTask(taskId: string, autoCommit?: boolean): Promise<boolean> {
		return archiveTask(this, taskId, autoCommit);
	}

	async createMilestone(title: string, description?: string, autoCommit?: boolean): Promise<Milestone> {
		const milestone = await this.fs.createMilestone(title, description);
		if (await this.shouldAutoCommit(autoCommit)) {
			const backlogDir = DEFAULT_DIRECTORIES.BACKLOG;
			const repoRoot = await this.git.stageBacklogDirectory(backlogDir);
			await this.git.commitChanges(`backlog: Create milestone ${milestone.id}`, repoRoot);
		}
		return milestone;
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
