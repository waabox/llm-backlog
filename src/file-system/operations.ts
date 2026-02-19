import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_DIRECTORIES, DEFAULT_FILES } from "../constants/index.ts";
import type { BacklogConfig, Decision, Document, Milestone, Task, TaskListFilter } from "../types/index.ts";
import { generateNextId } from "../utils/prefix-config.ts";
import { ConfigStore } from "./config-store.ts";
import { DecisionStore } from "./decision-store.ts";
import { DocumentStore } from "./document-store.ts";
import { DraftStore } from "./draft-store.ts";
import { MilestoneStore } from "./milestone-store.ts";
import { TaskStore } from "./task-store.ts";

export class FileSystem {
	private readonly backlogDir: string;
	private readonly projectRoot: string;
	private readonly configStore: ConfigStore;
	private readonly taskStore: TaskStore;
	private readonly draftStore: DraftStore;
	private readonly decisionStore: DecisionStore;
	private readonly documentStore: DocumentStore;
	private readonly milestoneStore: MilestoneStore;
	private migrationChecked = false;

	constructor(projectRoot: string) {
		this.projectRoot = projectRoot;
		this.backlogDir = join(projectRoot, DEFAULT_DIRECTORIES.BACKLOG);
		this.configStore = new ConfigStore(projectRoot, this.backlogDir);
		this.taskStore = new TaskStore(
			join(this.backlogDir, DEFAULT_DIRECTORIES.TASKS),
			join(this.backlogDir, DEFAULT_DIRECTORIES.COMPLETED),
			join(this.backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_TASKS),
			() => this.loadConfig(),
		);
		this.draftStore = new DraftStore(
			join(this.backlogDir, DEFAULT_DIRECTORIES.DRAFTS),
			join(this.backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_DRAFTS),
		);
		this.decisionStore = new DecisionStore(
			join(this.backlogDir, DEFAULT_DIRECTORIES.DECISIONS),
		);
		this.documentStore = new DocumentStore(
			join(this.backlogDir, DEFAULT_DIRECTORIES.DOCS),
		);
		this.milestoneStore = new MilestoneStore(
			join(this.backlogDir, DEFAULT_DIRECTORIES.MILESTONES),
			join(this.backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_MILESTONES),
		);
	}

	private async getBacklogDir(): Promise<string> {
		// Ensure legacy .backlog -> backlog migration is checked once
		if (!this.migrationChecked) {
			await this.configStore.loadConfigDirect();
			this.migrationChecked = true;
		}
		// Always use "backlog" as the directory name - no configuration needed
		return join(this.projectRoot, DEFAULT_DIRECTORIES.BACKLOG);
	}

	// Public accessors for directory paths
	get tasksDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.TASKS);
	}
	get completedDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.COMPLETED);
	}

	get archiveTasksDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_TASKS);
	}
	get archiveMilestonesDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_MILESTONES);
	}
	get decisionsDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.DECISIONS);
	}

	get docsDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.DOCS);
	}

	get milestonesDir(): string {
		return join(this.backlogDir, DEFAULT_DIRECTORIES.MILESTONES);
	}

	get configFilePath(): string {
		return join(this.backlogDir, DEFAULT_FILES.CONFIG);
	}

	/** Get the project root directory */
	get rootDir(): string {
		return this.projectRoot;
	}

	invalidateConfigCache(): void {
		this.configStore.invalidateConfigCache();
	}

	async getDraftsDir(): Promise<string> {
		const backlogDir = await this.getBacklogDir();
		return join(backlogDir, DEFAULT_DIRECTORIES.DRAFTS);
	}

	async getArchiveTasksDir(): Promise<string> {
		const backlogDir = await this.getBacklogDir();
		return join(backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_TASKS);
	}

	async ensureBacklogStructure(): Promise<void> {
		const backlogDir = await this.getBacklogDir();
		const directories = [
			backlogDir,
			join(backlogDir, DEFAULT_DIRECTORIES.TASKS),
			join(backlogDir, DEFAULT_DIRECTORIES.DRAFTS),
			join(backlogDir, DEFAULT_DIRECTORIES.COMPLETED),
			join(backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_TASKS),
			join(backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_DRAFTS),
			join(backlogDir, DEFAULT_DIRECTORIES.MILESTONES),
			join(backlogDir, DEFAULT_DIRECTORIES.ARCHIVE_MILESTONES),
			join(backlogDir, DEFAULT_DIRECTORIES.DOCS),
			join(backlogDir, DEFAULT_DIRECTORIES.DECISIONS),
		];

		for (const dir of directories) {
			await mkdir(dir, { recursive: true });
		}
	}

	// Task operations - delegated to TaskStore
	async saveTask(task: Task): Promise<string> {
		return this.taskStore.saveTask(task);
	}

	async loadTask(taskId: string): Promise<Task | null> {
		return this.taskStore.loadTask(taskId);
	}

	async listTasks(filter?: TaskListFilter): Promise<Task[]> {
		return this.taskStore.listTasks(filter);
	}

	async listCompletedTasks(): Promise<Task[]> {
		return this.taskStore.listCompletedTasks();
	}

	async listArchivedTasks(): Promise<Task[]> {
		return this.taskStore.listArchivedTasks();
	}

	async archiveTask(taskId: string): Promise<boolean> {
		return this.taskStore.archiveTask(taskId);
	}

	async completeTask(taskId: string): Promise<boolean> {
		return this.taskStore.completeTask(taskId);
	}

	// Draft operations - delegated to DraftStore
	async saveDraft(task: Task): Promise<string> {
		return this.draftStore.saveDraft(task);
	}

	async loadDraft(draftId: string): Promise<Task | null> {
		return this.draftStore.loadDraft(draftId);
	}

	async listDrafts(): Promise<Task[]> {
		return this.draftStore.listDrafts();
	}

	async archiveDraft(draftId: string): Promise<boolean> {
		return this.draftStore.archiveDraft(draftId);
	}

	// Cross-entity operations (task <-> draft) stay on FileSystem
	async promoteDraft(draftId: string): Promise<boolean> {
		try {
			// Load the draft
			const draft = await this.draftStore.loadDraft(draftId);
			if (!draft || !draft.filePath) return false;

			// Get task prefix from config (default: "task")
			const config = await this.loadConfig();
			const taskPrefix = config?.prefixes?.task ?? "task";

			// Get existing task IDs to generate next ID
			// Include both active and completed tasks to prevent ID collisions
			const existingTasks = await this.taskStore.listTasks();
			const completedTasks = await this.taskStore.listCompletedTasks();
			const existingIds = [...existingTasks, ...completedTasks].map((t) => t.id);

			// Generate new task ID
			const newTaskId = generateNextId(existingIds, taskPrefix, config?.zeroPaddedIds);

			// Update draft with new task ID and save as task
			const promotedTask: Task = {
				...draft,
				id: newTaskId,
				filePath: undefined, // Will be set by saveTask
			};

			await this.taskStore.saveTask(promotedTask);

			// Delete old draft file
			await unlink(draft.filePath);

			return true;
		} catch {
			return false;
		}
	}

	async demoteTask(taskId: string): Promise<boolean> {
		try {
			// Load the task
			const task = await this.taskStore.loadTask(taskId);
			if (!task || !task.filePath) return false;

			// Get existing draft IDs to generate next ID
			// Draft prefix is always "draft" (not configurable like task prefix)
			const existingDrafts = await this.draftStore.listDrafts();
			const existingIds = existingDrafts.map((d) => d.id);

			// Generate new draft ID
			const config = await this.loadConfig();
			const newDraftId = generateNextId(existingIds, "draft", config?.zeroPaddedIds);

			// Update task with new draft ID and save as draft
			const demotedDraft: Task = {
				...task,
				id: newDraftId,
				filePath: undefined, // Will be set by saveDraft
			};

			await this.draftStore.saveDraft(demotedDraft);

			// Delete old task file
			await unlink(task.filePath);

			return true;
		} catch {
			return false;
		}
	}

	// Decision operations - delegated to DecisionStore
	async saveDecision(decision: Decision): Promise<void> {
		return this.decisionStore.saveDecision(decision);
	}

	async loadDecision(decisionId: string): Promise<Decision | null> {
		return this.decisionStore.loadDecision(decisionId);
	}

	async listDecisions(): Promise<Decision[]> {
		return this.decisionStore.listDecisions();
	}

	// Document operations - delegated to DocumentStore
	async saveDocument(document: Document, subPath?: string): Promise<string> {
		return this.documentStore.saveDocument(document, subPath);
	}

	async listDocuments(): Promise<Document[]> {
		return this.documentStore.listDocuments();
	}

	async loadDocument(id: string): Promise<Document> {
		return this.documentStore.loadDocument(id);
	}

	// Milestone operations - delegated to MilestoneStore
	async listMilestones(): Promise<Milestone[]> {
		return this.milestoneStore.listMilestones();
	}

	async listArchivedMilestones(): Promise<Milestone[]> {
		return this.milestoneStore.listArchivedMilestones();
	}

	async loadMilestone(id: string): Promise<Milestone | null> {
		return this.milestoneStore.loadMilestone(id);
	}

	async createMilestone(title: string, description?: string): Promise<Milestone> {
		return this.milestoneStore.createMilestone(title, description);
	}

	async renameMilestone(
		identifier: string,
		title: string,
	): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		milestone?: Milestone;
		previousTitle?: string;
	}> {
		return this.milestoneStore.renameMilestone(identifier, title);
	}

	async archiveMilestone(identifier: string): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		milestone?: Milestone;
	}> {
		return this.milestoneStore.archiveMilestone(identifier);
	}

	// Config operations - delegated to ConfigStore
	async loadConfig(): Promise<BacklogConfig | null> {
		// Ensure legacy migration is checked before reading config
		if (!this.migrationChecked) {
			await this.configStore.loadConfigDirect();
			this.migrationChecked = true;
		}
		return this.configStore.loadConfig();
	}

	async saveConfig(config: BacklogConfig): Promise<void> {
		return this.configStore.saveConfig(config);
	}

	async getUserSetting(key: string, global = false): Promise<string | undefined> {
		return this.configStore.getUserSetting(key, global);
	}

	async setUserSetting(key: string, value: string, global = false): Promise<void> {
		return this.configStore.setUserSetting(key, value, global);
	}
}
