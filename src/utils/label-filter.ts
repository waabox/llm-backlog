import type { Task } from "../types/index.ts";

function normalizeLabel(label: string): string {
	return label.trim().toLowerCase();
}

/**
 * Collect available labels from configuration and tasks, de-duplicated but preserving
 * the first-seen casing so UI surfaces familiar labels.
 */
export function collectAvailableLabels(tasks: Task[], configured: string[] = []): string[] {
	const seen = new Set<string>();
	const ordered: string[] = [];

	const addLabel = (label: string | undefined) => {
		if (!label) return;
		const normalized = normalizeLabel(label);
		if (normalized.length === 0) return;
		if (seen.has(normalized)) return;
		seen.add(normalized);
		ordered.push(label);
	};

	for (const label of configured) {
		addLabel(label);
	}

	for (const task of tasks) {
		for (const label of task.labels || []) {
			addLabel(label);
		}
	}

	return ordered;
}
