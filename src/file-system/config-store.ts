import { rename } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_DIRECTORIES, DEFAULT_FILES, DEFAULT_STATUSES } from "../constants/index.ts";
import type { BacklogConfig } from "../types/index.ts";
import { ensureDirectoryExists } from "./shared.ts";

export class ConfigStore {
	private readonly projectRoot: string;
	private readonly backlogDir: string;
	private cachedConfig: BacklogConfig | null = null;

	constructor(projectRoot: string, backlogDir: string) {
		this.projectRoot = projectRoot;
		this.backlogDir = backlogDir;
	}

	/**
	 * Load config directly from disk, handling legacy `.backlog` -> `backlog` migration.
	 * Used during initialization before the cache is populated.
	 */
	async loadConfigDirect(): Promise<BacklogConfig | null> {
		try {
			// First try the standard "backlog" directory
			let configPath = join(this.projectRoot, DEFAULT_DIRECTORIES.BACKLOG, DEFAULT_FILES.CONFIG);
			let file = Bun.file(configPath);
			let exists = await file.exists();

			// If not found, check for legacy ".backlog" directory and migrate it
			if (!exists) {
				const legacyBacklogDir = join(this.projectRoot, ".backlog");
				const legacyConfigPath = join(legacyBacklogDir, DEFAULT_FILES.CONFIG);
				const legacyFile = Bun.file(legacyConfigPath);
				const legacyExists = await legacyFile.exists();

				if (legacyExists) {
					// Migrate legacy .backlog directory to backlog
					const newBacklogDir = join(this.projectRoot, DEFAULT_DIRECTORIES.BACKLOG);
					await rename(legacyBacklogDir, newBacklogDir);

					// Update paths to use the new location
					configPath = join(this.projectRoot, DEFAULT_DIRECTORIES.BACKLOG, DEFAULT_FILES.CONFIG);
					file = Bun.file(configPath);
					exists = true;
				}
			}

			if (!exists) {
				return null;
			}

			const content = await file.text();
			return this.parseConfig(content);
		} catch (_error) {
			if (process.env.DEBUG) {
				console.error("Error loading config:", _error);
			}
			return null;
		}
	}

	/**
	 * Load config with caching. Returns cached version if available.
	 */
	async loadConfig(): Promise<BacklogConfig | null> {
		// Return cached config if available
		if (this.cachedConfig !== null) {
			return this.cachedConfig;
		}

		try {
			const configPath = join(this.backlogDir, DEFAULT_FILES.CONFIG);

			// Check if file exists first to avoid hanging on Windows
			const file = Bun.file(configPath);
			const exists = await file.exists();

			if (!exists) {
				return null;
			}

			const content = await file.text();
			const config = this.parseConfig(content);

			// Cache the loaded config
			this.cachedConfig = config;
			return config;
		} catch (_error) {
			return null;
		}
	}

	/**
	 * Save config to disk and update cache.
	 */
	async saveConfig(config: BacklogConfig): Promise<void> {
		const configPath = join(this.backlogDir, DEFAULT_FILES.CONFIG);
		const content = this.serializeConfig(config);
		await Bun.write(configPath, content);
		this.cachedConfig = config;
	}

	/**
	 * Invalidate the cached config so next load reads from disk.
	 */
	invalidateConfigCache(): void {
		this.cachedConfig = null;
	}

	/**
	 * Get a single user setting by key.
	 */
	async getUserSetting(key: string, global = false): Promise<string | undefined> {
		const settings = await this.loadUserSettings(global);
		return settings ? settings[key] : undefined;
	}

	/**
	 * Set a single user setting by key.
	 */
	async setUserSetting(key: string, value: string, global = false): Promise<void> {
		const settings = (await this.loadUserSettings(global)) || {};
		settings[key] = value;
		await this.saveUserSettings(settings, global);
	}

	private async loadUserSettings(global = false): Promise<Record<string, string> | null> {
		const primaryPath = global
			? join(homedir(), "backlog", DEFAULT_FILES.USER)
			: join(this.projectRoot, DEFAULT_FILES.USER);
		const fallbackPath = global ? join(this.projectRoot, "backlog", DEFAULT_FILES.USER) : undefined;
		const tryPaths = fallbackPath ? [primaryPath, fallbackPath] : [primaryPath];
		for (const filePath of tryPaths) {
			try {
				const content = await Bun.file(filePath).text();
				const result: Record<string, string> = {};
				for (const line of content.split(/\r?\n/)) {
					const trimmed = line.trim();
					if (!trimmed || trimmed.startsWith("#")) continue;
					const idx = trimmed.indexOf(":");
					if (idx === -1) continue;
					const k = trimmed.substring(0, idx).trim();
					result[k] = trimmed
						.substring(idx + 1)
						.trim()
						.replace(/^['"]|['"]$/g, "");
				}
				return result;
			} catch {
				// Try next path (if any)
			}
		}
		return null;
	}

	private async saveUserSettings(settings: Record<string, string>, global = false): Promise<void> {
		const primaryPath = global
			? join(homedir(), "backlog", DEFAULT_FILES.USER)
			: join(this.projectRoot, DEFAULT_FILES.USER);
		const fallbackPath = global ? join(this.projectRoot, "backlog", DEFAULT_FILES.USER) : undefined;

		const lines = Object.entries(settings).map(([k, v]) => `${k}: ${v}`);
		const data = `${lines.join("\n")}\n`;

		try {
			await ensureDirectoryExists(dirname(primaryPath));
			await Bun.write(primaryPath, data);
			return;
		} catch {
			// Fall through to fallback when global write fails (e.g., sandboxed env)
		}

		if (fallbackPath) {
			await ensureDirectoryExists(dirname(fallbackPath));
			await Bun.write(fallbackPath, data);
		}
	}

	private parseConfig(content: string): BacklogConfig {
		const config: Partial<BacklogConfig> = {};
		const lines = content.split("\n");

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;

			const colonIndex = trimmed.indexOf(":");
			if (colonIndex === -1) continue;

			const key = trimmed.substring(0, colonIndex).trim();
			const value = trimmed.substring(colonIndex + 1).trim();

			switch (key) {
				case "project_name":
					config.projectName = value.replace(/['"]/g, "");
					break;
				case "default_assignee":
					config.defaultAssignee = value.replace(/['"]/g, "");
					break;
				case "default_reporter":
					config.defaultReporter = value.replace(/['"]/g, "");
					break;
				case "default_status":
					config.defaultStatus = value.replace(/['"]/g, "");
					break;
				case "statuses":
				case "labels":
					if (value.startsWith("[") && value.endsWith("]")) {
						const arrayContent = value.slice(1, -1);
						config[key] = arrayContent
							.split(",")
							.map((item) => item.trim().replace(/['"]/g, ""))
							.filter(Boolean);
					}
					break;
				case "date_format":
					config.dateFormat = value.replace(/['"]/g, "");
					break;
				case "max_column_width":
					config.maxColumnWidth = Number.parseInt(value, 10);
					break;
				case "default_editor":
					config.defaultEditor = value.replace(/["']/g, "");
					break;
				case "auto_open_browser":
					config.autoOpenBrowser = value.toLowerCase() === "true";
					break;
				case "default_port":
					config.defaultPort = Number.parseInt(value, 10);
					break;
				case "remote_operations":
					config.remoteOperations = value.toLowerCase() === "true";
					break;
				case "auto_commit":
					config.autoCommit = value.toLowerCase() === "true";
					break;
				case "zero_padded_ids":
					config.zeroPaddedIds = Number.parseInt(value, 10);
					break;
				case "bypass_git_hooks":
					config.bypassGitHooks = value.toLowerCase() === "true";
					break;
				case "check_active_branches":
					config.checkActiveBranches = value.toLowerCase() === "true";
					break;
				case "active_branch_days":
					config.activeBranchDays = Number.parseInt(value, 10);
					break;
				case "onStatusChange":
				case "on_status_change":
					// Remove surrounding quotes if present, but preserve inner content
					config.onStatusChange = value.replace(/^['"]|['"]$/g, "");
					break;
				case "task_prefix":
					config.prefixes = { task: value.replace(/['"]/g, "") };
					break;
			}
		}

		return {
			projectName: config.projectName || "",
			defaultAssignee: config.defaultAssignee,
			defaultReporter: config.defaultReporter,
			statuses: config.statuses || [...DEFAULT_STATUSES],
			labels: config.labels || [],
			defaultStatus: config.defaultStatus,
			dateFormat: config.dateFormat || "yyyy-mm-dd",
			maxColumnWidth: config.maxColumnWidth,
			defaultEditor: config.defaultEditor,
			autoOpenBrowser: config.autoOpenBrowser,
			defaultPort: config.defaultPort,
			remoteOperations: config.remoteOperations,
			autoCommit: config.autoCommit,
			zeroPaddedIds: config.zeroPaddedIds,
			bypassGitHooks: config.bypassGitHooks,
			checkActiveBranches: config.checkActiveBranches,
			activeBranchDays: config.activeBranchDays,
			onStatusChange: config.onStatusChange,
			prefixes: config.prefixes,
		};
	}

	private serializeConfig(config: BacklogConfig): string {
		const lines = [
			`project_name: "${config.projectName}"`,
			...(config.defaultAssignee ? [`default_assignee: "${config.defaultAssignee}"`] : []),
			...(config.defaultReporter ? [`default_reporter: "${config.defaultReporter}"`] : []),
			...(config.defaultStatus ? [`default_status: "${config.defaultStatus}"`] : []),
			`statuses: [${config.statuses.map((s) => `"${s}"`).join(", ")}]`,
			`labels: [${config.labels.map((l) => `"${l}"`).join(", ")}]`,
			`date_format: ${config.dateFormat}`,
			...(config.maxColumnWidth ? [`max_column_width: ${config.maxColumnWidth}`] : []),
			...(config.defaultEditor ? [`default_editor: "${config.defaultEditor}"`] : []),
			...(typeof config.autoOpenBrowser === "boolean" ? [`auto_open_browser: ${config.autoOpenBrowser}`] : []),
			...(config.defaultPort ? [`default_port: ${config.defaultPort}`] : []),
			...(typeof config.remoteOperations === "boolean" ? [`remote_operations: ${config.remoteOperations}`] : []),
			...(typeof config.autoCommit === "boolean" ? [`auto_commit: ${config.autoCommit}`] : []),
			...(typeof config.zeroPaddedIds === "number" ? [`zero_padded_ids: ${config.zeroPaddedIds}`] : []),
			...(typeof config.bypassGitHooks === "boolean" ? [`bypass_git_hooks: ${config.bypassGitHooks}`] : []),
			...(typeof config.checkActiveBranches === "boolean"
				? [`check_active_branches: ${config.checkActiveBranches}`]
				: []),
			...(typeof config.activeBranchDays === "number" ? [`active_branch_days: ${config.activeBranchDays}`] : []),
			...(config.onStatusChange ? [`onStatusChange: '${config.onStatusChange}'`] : []),
			...(config.prefixes?.task ? [`task_prefix: "${config.prefixes.task}"`] : []),
		];

		return `${lines.join("\n")}\n`;
	}
}
