import type { Core } from "../core/backlog.ts";
import type { Task } from "../types/index.ts";
import { normalizeStringList } from "../utils/task-builders.ts";
import { normalizeTaskId, taskIdsEqual } from "../utils/task-path.ts";

/**
 * Normalize a raw dependency input (string, array, or falsy) into a list of
 * canonical task IDs.
 *
 * @param dependencies - Raw dependency value from CLI options
 * @returns Normalized list of task ID strings
 */
export function normalizeDependencies(dependencies: unknown): string[] {
	if (!dependencies) return [];

	const normalizeList = (values: string[]): string[] =>
		values
			.map((value) => value.trim())
			.filter((value): value is string => value.length > 0)
			.map((value) => normalizeTaskId(value));

	if (Array.isArray(dependencies)) {
		return normalizeList(
			dependencies.flatMap((dep) =>
				String(dep)
					.split(",")
					.map((d) => d.trim()),
			),
		);
	}

	return normalizeList(String(dependencies).split(","));
}

/**
 * Validate that all specified dependency task IDs actually exist in the project.
 *
 * @param dependencies - List of dependency task IDs to validate
 * @param core - Core instance for querying tasks and drafts
 * @returns Object with valid and invalid dependency arrays
 */
export async function validateDependencies(
	dependencies: string[],
	core: Core,
): Promise<{ valid: string[]; invalid: string[] }> {
	const valid: string[] = [];
	const invalid: string[] = [];

	if (dependencies.length === 0) {
		return { valid, invalid };
	}

	// Load both tasks and drafts to validate dependencies
	const [tasks, drafts] = await Promise.all([core.queryTasks(), core.fs.listDrafts()]);

	const knownIds = [...tasks.map((task) => task.id), ...drafts.map((draft) => draft.id)];
	for (const dep of dependencies) {
		const match = knownIds.find((id) => taskIdsEqual(dep, id));
		if (match) {
			valid.push(match);
		} else {
			invalid.push(dep);
		}
	}

	return { valid, invalid };
}

/**
 * Build a Task object from CLI option values.
 *
 * Shared between task create and draft create commands to ensure consistent
 * behavior across both workflows.
 *
 * @param id - Task or draft ID
 * @param title - Task title
 * @param options - Raw CLI options record
 * @returns Constructed Task object
 */
export function buildTaskFromOptions(id: string, title: string, options: Record<string, unknown>): Task {
	const parentInput = options.parent ? String(options.parent) : undefined;
	const normalizedParent = parentInput ? normalizeTaskId(parentInput) : undefined;

	const createdDate = new Date().toISOString().slice(0, 16).replace("T", " ");

	// Handle dependencies - they will be validated separately
	const dependencies = normalizeDependencies(options.dependsOn || options.dep);

	// Handle references (URLs or file paths)
	const references = normalizeStringList(
		Array.isArray(options.ref)
			? options.ref.flatMap((r: string) =>
					String(r)
						.split(",")
						.map((s: string) => s.trim()),
				)
			: options.ref
				? String(options.ref)
						.split(",")
						.map((s: string) => s.trim())
				: [],
	);

	// Handle documentation (URLs or file paths)
	const documentation = normalizeStringList(
		Array.isArray(options.doc)
			? options.doc.flatMap((d: string) =>
					String(d)
						.split(",")
						.map((s: string) => s.trim()),
				)
			: options.doc
				? String(options.doc)
						.split(",")
						.map((s: string) => s.trim())
				: [],
	);

	// Validate priority option
	const priority = options.priority ? String(options.priority).toLowerCase() : undefined;
	const validPriorities = ["high", "medium", "low"];
	const validatedPriority =
		priority && validPriorities.includes(priority) ? (priority as "high" | "medium" | "low") : undefined;

	return {
		id,
		title,
		status: options.status ? String(options.status) : "",
		assignee: options.assignee ? [String(options.assignee)] : [],
		createdDate,
		labels: options.labels
			? String(options.labels)
					.split(",")
					.map((l: string) => l.trim())
					.filter(Boolean)
			: [],
		dependencies,
		references,
		documentation,
		rawContent: "",
		...(options.description || options.desc ? { description: String(options.description || options.desc) } : {}),
		...(normalizedParent && { parentTaskId: normalizedParent }),
		...(validatedPriority && { priority: validatedPriority }),
	};
}
