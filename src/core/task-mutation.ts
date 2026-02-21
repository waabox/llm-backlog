import { isLocalEditableTask, type Task, type TaskListFilter, type TaskUpdateInput } from "../types/index.ts";
import { extractAnyPrefix } from "../utils/prefix-config.ts";
import {
	normalizeDependencies,
	normalizeStringList,
	stringArraysEqual,
	validateDependencies,
} from "../utils/task-builders.ts";
import { normalizeTaskId, taskIdsEqual } from "../utils/task-path.ts";
import type { Core } from "./backlog.ts";

/**
 * Filters a task list by the given filter criteria.
 */
export function applyTaskFilters(tasks: Task[], filters?: TaskListFilter): Task[] {
	if (!filters) {
		return tasks;
	}
	let result = tasks;
	if (filters.status) {
		const statusLower = filters.status.toLowerCase();
		result = result.filter((task) => (task.status ?? "").toLowerCase() === statusLower);
	}
	if (filters.assignee) {
		const assigneeLower = filters.assignee.toLowerCase();
		result = result.filter((task) => (task.assignee ?? []).some((value) => value.toLowerCase() === assigneeLower));
	}
	if (filters.priority) {
		const priorityLower = String(filters.priority).toLowerCase();
		result = result.filter((task) => (task.priority ?? "").toLowerCase() === priorityLower);
	}
	if (filters.parentTaskId) {
		const parentFilter = filters.parentTaskId;
		result = result.filter((task) => task.parentTaskId && taskIdsEqual(parentFilter, task.parentTaskId));
	}
	if (filters.labels && filters.labels.length > 0) {
		const requiredLabels = filters.labels.map((label) => label.toLowerCase()).filter(Boolean);
		if (requiredLabels.length > 0) {
			result = result.filter((task) => {
				const taskLabels = task.labels?.map((label) => label.toLowerCase()) || [];
				if (taskLabels.length === 0) return false;
				const labelSet = new Set(taskLabels);
				return requiredLabels.some((label) => labelSet.has(label));
			});
		}
	}
	return result;
}

/**
 * Returns only tasks that are locally editable (not read-only cross-branch tasks).
 */
export function filterLocalEditableTasks(tasks: Task[]): Task[] {
	return tasks.filter(isLocalEditableTask);
}

/**
 * Normalizes a raw priority string to one of the allowed values, or undefined if empty.
 * Throws if the value is not a valid priority.
 */
export function normalizePriority(value: string | undefined): ("high" | "medium" | "low") | undefined {
	if (value === undefined || value === "") {
		return undefined;
	}
	const normalized = value.toLowerCase();
	const allowed = ["high", "medium", "low"] as const;
	if (!allowed.includes(normalized as (typeof allowed)[number])) {
		throw new Error(`Invalid priority: ${value}. Valid values are: high, medium, low`);
	}
	return normalized as "high" | "medium" | "low";
}

/**
 * Returns true if the given reference string refers exactly to the given task ID.
 */
export function isExactTaskReference(reference: string, taskId: string): boolean {
	const trimmed = reference.trim();
	if (!trimmed) {
		return false;
	}
	const taskPrefix = extractAnyPrefix(taskId);
	const referencePrefix = extractAnyPrefix(trimmed);
	if (!taskPrefix || !referencePrefix) {
		return false;
	}
	if (taskPrefix.toLowerCase() !== referencePrefix.toLowerCase()) {
		return false;
	}
	return normalizeTaskId(trimmed, taskPrefix).toLowerCase() === normalizeTaskId(taskId, taskPrefix).toLowerCase();
}

/**
 * Returns all tasks from the list that reference the archived task, with those
 * references removed. Tasks with no references to the archived task are excluded.
 */
export function sanitizeArchivedTaskLinks(tasks: Task[], archivedTaskId: string): Task[] {
	const changedTasks: Task[] = [];

	for (const task of tasks) {
		const dependencies = task.dependencies ?? [];
		const references = task.references ?? [];

		const sanitizedDependencies = dependencies.filter((dependency) => !taskIdsEqual(dependency, archivedTaskId));
		const sanitizedReferences = references.filter((reference) => !isExactTaskReference(reference, archivedTaskId));

		const dependenciesChanged = !stringArraysEqual(dependencies, sanitizedDependencies);
		const referencesChanged = !stringArraysEqual(references, sanitizedReferences);
		if (!dependenciesChanged && !referencesChanged) {
			continue;
		}

		changedTasks.push({
			...task,
			dependencies: sanitizedDependencies,
			references: sanitizedReferences,
		});
	}

	return changedTasks;
}

/**
 * Applies a TaskUpdateInput to a task, mutating it in-place and returning whether
 * any field was actually changed. statusResolver is called for status normalization.
 * core is required for dependency validation.
 */
export async function applyTaskUpdateInput(
	task: Task,
	input: TaskUpdateInput,
	statusResolver: (status: string) => Promise<string>,
	core: Core,
): Promise<{ task: Task; mutated: boolean }> {
	let mutated = false;

	const applyStringField = (value: string | undefined, current: string | undefined, assign: (next: string) => void) => {
		if (typeof value === "string") {
			const next = value;
			if ((current ?? "") !== next) {
				assign(next);
				mutated = true;
			}
		}
	};

	if (input.title !== undefined) {
		const trimmed = input.title.trim();
		if (trimmed.length === 0) {
			throw new Error("Title cannot be empty.");
		}
		if (task.title !== trimmed) {
			task.title = trimmed;
			mutated = true;
		}
	}

	applyStringField(input.description, task.description, (next) => {
		task.description = next;
	});

	if (input.status !== undefined) {
		const canonicalStatus = await statusResolver(input.status);
		if ((task.status ?? "") !== canonicalStatus) {
			task.status = canonicalStatus;
			mutated = true;
		}
	}

	if (input.priority !== undefined) {
		const normalizedPriority = normalizePriority(String(input.priority));
		if (task.priority !== normalizedPriority) {
			task.priority = normalizedPriority;
			mutated = true;
		}
	}

	if (input.milestone !== undefined) {
		const normalizedMilestone =
			input.milestone === null ? undefined : input.milestone.trim().length > 0 ? input.milestone.trim() : undefined;
		if ((task.milestone ?? undefined) !== normalizedMilestone) {
			if (normalizedMilestone === undefined) {
				delete task.milestone;
			} else {
				task.milestone = normalizedMilestone;
			}
			mutated = true;
		}
	}

	if (input.ordinal !== undefined) {
		if (Number.isNaN(input.ordinal) || input.ordinal < 0) {
			throw new Error("Ordinal must be a non-negative number.");
		}
		if (task.ordinal !== input.ordinal) {
			task.ordinal = input.ordinal;
			mutated = true;
		}
	}

	if (input.assignee !== undefined) {
		const sanitizedAssignee = normalizeStringList(input.assignee) ?? [];
		if (!stringArraysEqual(sanitizedAssignee, task.assignee ?? [])) {
			task.assignee = sanitizedAssignee;
			mutated = true;
		}
	}

	const resolveLabelChanges = (): void => {
		let currentLabels = [...(task.labels ?? [])];
		if (input.labels !== undefined) {
			const sanitizedLabels = normalizeStringList(input.labels) ?? [];
			if (!stringArraysEqual(sanitizedLabels, currentLabels)) {
				task.labels = sanitizedLabels;
				mutated = true;
			}
			currentLabels = sanitizedLabels;
		}

		const labelsToAdd = normalizeStringList(input.addLabels) ?? [];
		if (labelsToAdd.length > 0) {
			const labelSet = new Set(currentLabels.map((label) => label.toLowerCase()));
			for (const label of labelsToAdd) {
				if (!labelSet.has(label.toLowerCase())) {
					currentLabels.push(label);
					labelSet.add(label.toLowerCase());
					mutated = true;
				}
			}
			task.labels = currentLabels;
		}

		const labelsToRemove = normalizeStringList(input.removeLabels) ?? [];
		if (labelsToRemove.length > 0) {
			const removalSet = new Set(labelsToRemove.map((label) => label.toLowerCase()));
			const filtered = currentLabels.filter((label) => !removalSet.has(label.toLowerCase()));
			if (!stringArraysEqual(filtered, currentLabels)) {
				task.labels = filtered;
				mutated = true;
			}
		}
	};

	resolveLabelChanges();

	const resolveDependencies = async (): Promise<void> => {
		let currentDependencies = [...(task.dependencies ?? [])];

		if (input.dependencies !== undefined) {
			const normalized = normalizeDependencies(input.dependencies);
			const { valid, invalid } = await validateDependencies(normalized, core);
			if (invalid.length > 0) {
				throw new Error(
					`The following dependencies do not exist: ${invalid.join(", ")}. Please create these tasks first or verify the IDs.`,
				);
			}
			if (!stringArraysEqual(valid, currentDependencies)) {
				currentDependencies = valid;
				mutated = true;
			}
		}

		if (input.addDependencies && input.addDependencies.length > 0) {
			const additions = normalizeDependencies(input.addDependencies);
			const { valid, invalid } = await validateDependencies(additions, core);
			if (invalid.length > 0) {
				throw new Error(
					`The following dependencies do not exist: ${invalid.join(", ")}. Please create these tasks first or verify the IDs.`,
				);
			}
			const depSet = new Set(currentDependencies);
			for (const dep of valid) {
				if (!depSet.has(dep)) {
					currentDependencies.push(dep);
					depSet.add(dep);
					mutated = true;
				}
			}
		}

		if (input.removeDependencies && input.removeDependencies.length > 0) {
			const removals = new Set(normalizeDependencies(input.removeDependencies));
			const filtered = currentDependencies.filter((dep) => !removals.has(dep));
			if (!stringArraysEqual(filtered, currentDependencies)) {
				currentDependencies = filtered;
				mutated = true;
			}
		}

		task.dependencies = currentDependencies;
	};

	await resolveDependencies();

	const resolveReferences = (): void => {
		let currentReferences = [...(task.references ?? [])];
		if (input.references !== undefined) {
			const sanitizedReferences = normalizeStringList(input.references) ?? [];
			if (!stringArraysEqual(sanitizedReferences, currentReferences)) {
				task.references = sanitizedReferences;
				mutated = true;
			}
			currentReferences = sanitizedReferences;
		}

		const referencesToAdd = normalizeStringList(input.addReferences) ?? [];
		if (referencesToAdd.length > 0) {
			const refSet = new Set(currentReferences);
			for (const ref of referencesToAdd) {
				if (!refSet.has(ref)) {
					currentReferences.push(ref);
					refSet.add(ref);
					mutated = true;
				}
			}
			task.references = currentReferences;
		}

		const referencesToRemove = normalizeStringList(input.removeReferences) ?? [];
		if (referencesToRemove.length > 0) {
			const removalSet = new Set(referencesToRemove);
			const filtered = currentReferences.filter((ref) => !removalSet.has(ref));
			if (!stringArraysEqual(filtered, currentReferences)) {
				task.references = filtered;
				mutated = true;
			}
		}
	};

	resolveReferences();

	const resolveDocumentation = (): void => {
		let currentDocumentation = [...(task.documentation ?? [])];
		if (input.documentation !== undefined) {
			const sanitizedDocumentation = normalizeStringList(input.documentation) ?? [];
			if (!stringArraysEqual(sanitizedDocumentation, currentDocumentation)) {
				task.documentation = sanitizedDocumentation;
				mutated = true;
			}
			currentDocumentation = sanitizedDocumentation;
		}

		const documentationToAdd = normalizeStringList(input.addDocumentation) ?? [];
		if (documentationToAdd.length > 0) {
			const docSet = new Set(currentDocumentation);
			for (const doc of documentationToAdd) {
				if (!docSet.has(doc)) {
					currentDocumentation.push(doc);
					docSet.add(doc);
					mutated = true;
				}
			}
			task.documentation = currentDocumentation;
		}

		const documentationToRemove = normalizeStringList(input.removeDocumentation) ?? [];
		if (documentationToRemove.length > 0) {
			const removalSet = new Set(documentationToRemove);
			const filtered = currentDocumentation.filter((doc) => !removalSet.has(doc));
			if (!stringArraysEqual(filtered, currentDocumentation)) {
				task.documentation = filtered;
				mutated = true;
			}
		}
	};

	resolveDocumentation();

	const sanitizeAppendInput = (values: string[] | undefined): string[] => {
		if (!values) return [];
		return values.map((value) => String(value).trim()).filter((value) => value.length > 0);
	};

	const appendBlock = (
		existing: string | undefined,
		additions: string[] | undefined,
	): { value?: string; changed: boolean } => {
		const sanitizedAdditions = (additions ?? [])
			.map((value) => String(value).trim())
			.filter((value) => value.length > 0);
		if (sanitizedAdditions.length === 0) {
			return { value: existing, changed: false };
		}
		const current = (existing ?? "").trim();
		const additionBlock = sanitizedAdditions.join("\n\n");
		if (current.length === 0) {
			return { value: additionBlock, changed: true };
		}
		return { value: `${current}\n\n${additionBlock}`, changed: true };
	};

	if (input.clearImplementationPlan) {
		if (task.implementationPlan !== undefined) {
			delete task.implementationPlan;
			mutated = true;
		}
	}

	applyStringField(input.implementationPlan, task.implementationPlan, (next) => {
		task.implementationPlan = next;
	});

	const planAppends = sanitizeAppendInput(input.appendImplementationPlan);
	if (planAppends.length > 0) {
		const { value, changed } = appendBlock(task.implementationPlan, planAppends);
		if (changed) {
			task.implementationPlan = value;
			mutated = true;
		}
	}

	if (input.clearFinalSummary) {
		if (task.finalSummary !== undefined) {
			task.finalSummary = "";
			mutated = true;
		}
	}

	applyStringField(input.finalSummary, task.finalSummary, (next) => {
		task.finalSummary = next;
	});

	const finalSummaryAppends = sanitizeAppendInput(input.appendFinalSummary);
	if (finalSummaryAppends.length > 0) {
		const { value, changed } = appendBlock(task.finalSummary, finalSummaryAppends);
		if (changed) {
			task.finalSummary = value;
			mutated = true;
		}
	}

	return { task, mutated };
}
