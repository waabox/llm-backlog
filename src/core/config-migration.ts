import { join } from "node:path";
import type { FileSystem } from "../file-system/operations.ts";
import type { BacklogConfig } from "../types/index.ts";

/**
 * Migrates config to ensure all required fields exist with default values
 */
export function migrateConfig(config: Partial<BacklogConfig>): BacklogConfig {
	const defaultConfig: BacklogConfig = {
		projectName: "Untitled Project",
		defaultEditor: "",
		defaultStatus: "",
		statuses: ["To Do", "In Progress", "Done"],
		labels: [],
		dateFormat: "YYYY-MM-DD",
		maxColumnWidth: 80,
		autoOpenBrowser: true,
		defaultPort: 6420,
		remoteOperations: true,
		autoCommit: false,
		bypassGitHooks: false,
		checkActiveBranches: true,
		activeBranchDays: 30,
	};

	// Merge provided config with defaults, ensuring all fields exist
	// Only include fields from config that are not undefined
	const filteredConfig = Object.fromEntries(Object.entries(config).filter(([_, value]) => value !== undefined));

	const migratedConfig: BacklogConfig = {
		...defaultConfig,
		...filteredConfig,
	};

	// Ensure arrays are not undefined
	migratedConfig.statuses = config.statuses || defaultConfig.statuses;
	migratedConfig.labels = config.labels || defaultConfig.labels;

	return migratedConfig;
}

/**
 * Checks if config needs migration (missing any expected fields)
 */
export function needsMigration(config: Partial<BacklogConfig>): boolean {
	// Check for all expected fields including new ones
	// We need to check not just presence but also that they aren't undefined
	const expectedFieldsWithDefaults = [
		{ field: "projectName", hasDefault: true },
		{ field: "statuses", hasDefault: true },
		{ field: "defaultPort", hasDefault: true },
		{ field: "autoOpenBrowser", hasDefault: true },
		{ field: "remoteOperations", hasDefault: true },
		{ field: "autoCommit", hasDefault: true },
	];

	return expectedFieldsWithDefaults.some(({ field }) => {
		const value = config[field as keyof BacklogConfig];
		return value === undefined;
	});
}

/**
 * Parses a legacy inline YAML array value (e.g. "foo, 'bar', baz")
 */
export function parseLegacyInlineArray(value: string): string[] {
	const items: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	const pushCurrent = () => {
		const normalized = current.trim().replace(/\\(['"])/g, "$1");
		if (normalized) {
			items.push(normalized);
		}
		current = "";
	};

	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		const prev = i > 0 ? value[i - 1] : "";
		if (quote) {
			if (ch === quote && prev !== "\\") {
				quote = null;
				continue;
			}
			current += ch;
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === ",") {
			pushCurrent();
			continue;
		}
		current += ch;
	}
	pushCurrent();
	return items;
}

/**
 * Strips an inline YAML comment from a value string, respecting quoted strings
 */
export function stripYamlComment(value: string): string {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		const prev = i > 0 ? value[i - 1] : "";
		if (quote) {
			if (ch === quote && prev !== "\\") {
				quote = null;
			}
			continue;
		}
		if (ch === '"' || ch === "'") {
			quote = ch;
			continue;
		}
		if (ch === "#") {
			return value.slice(0, i).trimEnd();
		}
	}
	return value;
}

/**
 * Parses a legacy YAML scalar value, stripping comments and unquoting
 */
export function parseLegacyYamlValue(value: string): string {
	const trimmed = stripYamlComment(value).trim();
	const singleQuoted = trimmed.match(/^'(.*)'$/);
	if (singleQuoted?.[1] !== undefined) {
		return singleQuoted[1].replace(/''/g, "'");
	}
	const doubleQuoted = trimmed.match(/^"(.*)"$/);
	if (doubleQuoted?.[1] !== undefined) {
		return doubleQuoted[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
	}
	return trimmed;
}

/**
 * Reads the legacy milestones list from config.yml in the given backlog directory.
 * Returns an empty array if not found or on any error.
 */
export async function extractLegacyConfigMilestones(backlogDir: string): Promise<string[]> {
	try {
		const configPath = join(backlogDir, "config.yml");
		const content = await Bun.file(configPath).text();
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i += 1) {
			const line = lines[i] ?? "";
			const match = line.match(/^(\s*)milestones\s*:\s*(.*)$/);
			if (!match) {
				continue;
			}

			const milestoneIndent = (match[1] ?? "").length;
			const trailing = stripYamlComment(match[2] ?? "").trim();
			if (trailing.startsWith("[")) {
				let combined = trailing;
				let closed = trailing.endsWith("]");
				let j = i + 1;
				while (!closed && j < lines.length) {
					const segment = stripYamlComment(lines[j] ?? "").trim();
					combined += segment;
					if (segment.includes("]")) {
						closed = true;
						break;
					}
					j += 1;
				}
				if (closed) {
					const openIndex = combined.indexOf("[");
					const closeIndex = combined.lastIndexOf("]");
					if (openIndex !== -1 && closeIndex > openIndex) {
						const parsed = parseLegacyInlineArray(combined.slice(openIndex + 1, closeIndex));
						return parsed.map((item) => parseLegacyYamlValue(item)).filter(Boolean);
					}
				}
			}
			if (trailing.length > 0) {
				const single = parseLegacyYamlValue(trailing);
				return single ? [single] : [];
			}

			const values: string[] = [];
			for (let j = i + 1; j < lines.length; j += 1) {
				const nextLine = lines[j] ?? "";
				if (!nextLine.trim()) {
					continue;
				}
				const nextIndent = nextLine.match(/^\s*/)?.[0].length ?? 0;
				if (nextIndent <= milestoneIndent) {
					break;
				}
				const trimmed = nextLine.trim();
				if (!trimmed.startsWith("-")) {
					continue;
				}
				const itemValue = parseLegacyYamlValue(trimmed.slice(1));
				if (itemValue) {
					values.push(itemValue);
				}
			}
			return values;
		}
		return [];
	} catch {
		return [];
	}
}

/**
 * Migrates legacy milestone names from config.yml into individual milestone files.
 */
export async function migrateLegacyConfigMilestonesToFiles(legacyMilestones: string[], fs: FileSystem): Promise<void> {
	if (legacyMilestones.length === 0) {
		return;
	}
	const existingMilestones = await fs.listMilestones();
	const existingKeys = new Set<string>();
	for (const milestone of existingMilestones) {
		const idKey = milestone.id.trim().toLowerCase();
		const titleKey = milestone.title.trim().toLowerCase();
		if (idKey) {
			existingKeys.add(idKey);
		}
		if (titleKey) {
			existingKeys.add(titleKey);
		}
	}
	for (const name of legacyMilestones) {
		const normalized = name.trim();
		const key = normalized.toLowerCase();
		if (!normalized || existingKeys.has(key)) {
			continue;
		}
		const created = await fs.createMilestone(normalized);
		const createdIdKey = created.id.trim().toLowerCase();
		const createdTitleKey = created.title.trim().toLowerCase();
		if (createdIdKey) {
			existingKeys.add(createdIdKey);
		}
		if (createdTitleKey) {
			existingKeys.add(createdTitleKey);
		}
	}
}
