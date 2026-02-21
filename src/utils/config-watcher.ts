import { type FSWatcher, watch } from "node:fs";
import { dirname } from "node:path";
import type { Core } from "../core/backlog.ts";
import type { BacklogConfig } from "../types/index.ts";

export interface ConfigWatcherCallbacks {
	onConfigChanged?: (config: BacklogConfig | null) => void | Promise<void>;
}

/**
 * Watches the backlog directory recursively for any file changes.
 * Useful for notifying the web UI when external processes (e.g. MCP) mutate tasks.
 *
 * @param core - The Core instance whose backlog directory will be watched.
 * @param onChange - Callback invoked on any file change inside the backlog directory.
 * @returns An object with a stop function to cancel the watcher.
 */
export function watchBacklogDir(core: Core, onChange: () => void): { stop: () => void } {
	const backlogDir = dirname(core.filesystem.tasksDir);
	let watcher: FSWatcher | null = null;

	const stop = () => {
		if (watcher) {
			try {
				watcher.close();
			} catch {
				// Ignore
			}
			watcher = null;
		}
	};

	try {
		watcher = watch(backlogDir, { recursive: true }, (eventType) => {
			if (eventType === "change" || eventType === "rename") {
				onChange();
			}
		});
	} catch {
		// Silently ignore if directory doesn't exist yet
	}

	return { stop };
}

export function watchConfig(core: Core, callbacks: ConfigWatcherCallbacks): { stop: () => void } {
	const configPath = core.filesystem.configFilePath;
	let watcher: FSWatcher | null = null;

	const stop = () => {
		if (watcher) {
			try {
				watcher.close();
			} catch {
				// Ignore
			}
			watcher = null;
		}
	};

	try {
		watcher = watch(configPath, async (eventType) => {
			if (eventType !== "change" && eventType !== "rename") {
				return;
			}
			try {
				core.filesystem.invalidateConfigCache();
				const config = await core.filesystem.loadConfig();
				await callbacks.onConfigChanged?.(config);
			} catch {
				// Ignore read errors; subsequent events will retry
			}
		});
	} catch {
		// If watching fails (e.g., file missing), keep silent; caller can retry via onConfigChanged
	}

	return { stop };
}
