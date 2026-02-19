import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import { formatTaskPlainText } from "../formatters/task-plain-text.ts";
import { EntityType, type Task, type TaskListFilter } from "../types/index.ts";
import type { TaskEditArgs } from "../types/task-edit-args.ts";
import { viewTaskEnhanced } from "../ui/task-viewer-with-search.ts";
import { formatValidStatuses, getCanonicalStatus, getValidStatuses } from "../utils/status.ts";
import {
	buildDefinitionOfDoneItems,
	normalizeStringList,
	parsePositiveIndexList,
	processAcceptanceCriteriaOptions,
	toStringArray,
} from "../utils/task-builders.ts";
import { buildTaskUpdateInput } from "../utils/task-edit-builder.ts";
import { normalizeTaskId, taskIdsEqual } from "../utils/task-path.ts";
import { sortTasks } from "../utils/task-sorting.ts";
import { createMultiValueAccumulator, isPlainRequested, requireProjectRoot } from "./shared.ts";
import { buildTaskFromOptions, normalizeDependencies, validateDependencies } from "./task-helpers.ts";

/**
 * Register the task command group for managing project tasks.
 *
 * Includes subcommands: create, list, edit, view, archive, demote,
 * and a bare [taskId] fallback for quick viewing.
 *
 * @param program - Commander program instance
 */
export function registerTaskCommand(program: Command): void {
	const hasInteractiveTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
	const shouldAutoPlain = !hasInteractiveTTY;
	const plainFlagInArgv = process.argv.includes("--plain");

	function isPlainLocal(options?: { plain?: boolean }): boolean {
		return isPlainRequested(options, plainFlagInArgv);
	}

	const taskCmd = program.command("task").aliases(["tasks"]);

	taskCmd
		.command("create <title>")
		.option(
			"-d, --description <text>",
			"task description (multi-line: bash $'Line1\\nLine2', POSIX printf, PowerShell \"Line1`nLine2\")",
		)
		.option("--desc <text>", "alias for --description")
		.option("-a, --assignee <assignee>")
		.option("-s, --status <status>")
		.option("-l, --labels <labels>")
		.option("--priority <priority>", "set task priority (high, medium, low)")
		.option("--plain", "use plain text output after creating")
		.option("--ac <criteria>", "add acceptance criteria (can be used multiple times)", createMultiValueAccumulator())
		.option(
			"--acceptance-criteria <criteria>",
			"add acceptance criteria (can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option("--dod <item>", "add Definition of Done item (can be used multiple times)", createMultiValueAccumulator())
		.option("--no-dod-defaults", "disable Definition of Done defaults")
		.option("--plan <text>", "add implementation plan")
		.option("--notes <text>", "add implementation notes")
		.option("--final-summary <text>", "add final summary")
		.option("--draft")
		.option("-p, --parent <taskId>", "specify parent task ID")
		.option(
			"--depends-on <taskIds>",
			"specify task dependencies (comma-separated or use multiple times)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.option(
			"--dep <taskIds>",
			"specify task dependencies (shortcut for --depends-on)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.option(
			"--ref <reference>",
			"add reference URL or file path (can be used multiple times)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.option(
			"--doc <documentation>",
			"add documentation URL or file path (can be used multiple times)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.action(async (title: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			await core.ensureConfigLoaded();
			const createAsDraft = Boolean(options.draft);
			const id = await core.generateNextId(
				createAsDraft ? EntityType.Draft : EntityType.Task,
				createAsDraft ? undefined : options.parent,
			);
			const task = buildTaskFromOptions(id, title, options);

			// Normalize and validate status if provided (case-insensitive)
			if (options.status) {
				const canonical = await getCanonicalStatus(String(options.status), core);
				if (!canonical) {
					const configuredStatuses = await getValidStatuses(core);
					console.error(
						`Invalid status: ${options.status}. Valid statuses are: ${formatValidStatuses(configuredStatuses)}`,
					);
					process.exitCode = 1;
					return;
				}
				task.status = canonical;
			}

			// Validate dependencies if provided
			if (task.dependencies.length > 0) {
				const { valid, invalid } = await validateDependencies(task.dependencies, core);
				if (invalid.length > 0) {
					console.error(`Error: The following dependencies do not exist: ${invalid.join(", ")}`);
					console.error("Please create these tasks first or check the task IDs.");
					process.exitCode = 1;
					return;
				}
				task.dependencies = valid;
			}

			// Handle acceptance criteria for create command (structured only)
			const criteria = processAcceptanceCriteriaOptions(options);
			if (criteria.length > 0) {
				let idx = 1;
				task.acceptanceCriteriaItems = criteria.map((text) => ({ index: idx++, text, checked: false }));
			}

			const config = await core.filesystem.loadConfig();
			const dodItems = buildDefinitionOfDoneItems({
				defaults: config?.definitionOfDone,
				add: toStringArray(options.dod),
				disableDefaults: options.dodDefaults === false,
			});
			if (dodItems) {
				task.definitionOfDoneItems = dodItems;
			}

			// Handle implementation plan
			if (options.plan) {
				task.implementationPlan = String(options.plan);
			}

			// Handle implementation notes
			if (options.notes) {
				task.implementationNotes = String(options.notes);
			}

			// Handle final summary
			if (options.finalSummary) {
				task.finalSummary = String(options.finalSummary);
			}

			const usePlainOutput = isPlainLocal(options);

			if (createAsDraft) {
				const filepath = await core.createDraft(task);
				if (usePlainOutput) {
					console.log(formatTaskPlainText(task, { filePathOverride: filepath }));
					return;
				}
				console.log(`Created draft ${task.id}`);
				console.log(`File: ${filepath}`);
			} else {
				const filepath = await core.createTask(task);
				if (usePlainOutput) {
					console.log(formatTaskPlainText(task, { filePathOverride: filepath }));
					return;
				}
				console.log(`Created task ${task.id}`);
				console.log(`File: ${filepath}`);
			}
		});

	taskCmd
		.command("list")
		.description("list tasks grouped by status")
		.option("-s, --status <status>", "filter tasks by status (case-insensitive)")
		.option("-a, --assignee <assignee>", "filter tasks by assignee")
		.option("-p, --parent <taskId>", "filter tasks by parent task ID")
		.option("--priority <priority>", "filter tasks by priority (high, medium, low)")
		.option("--sort <field>", "sort tasks by field (priority, id)")
		.option("--plain", "use plain text output instead of interactive UI")
		.action(async (options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const cleanup = () => {
				core.disposeSearchService();
				core.disposeContentStore();
			};
			const baseFilters: TaskListFilter = {};
			if (options.status) {
				baseFilters.status = options.status;
			}
			if (options.assignee) {
				baseFilters.assignee = options.assignee;
			}
			if (options.priority) {
				const priorityLower = options.priority.toLowerCase();
				const validPriorities = ["high", "medium", "low"] as const;
				if (!validPriorities.includes(priorityLower as (typeof validPriorities)[number])) {
					console.error(`Invalid priority: ${options.priority}. Valid values are: high, medium, low`);
					process.exitCode = 1;
					cleanup();
					return;
				}
				baseFilters.priority = priorityLower as (typeof validPriorities)[number];
			}

			let parentId: string | undefined;
			if (options.parent) {
				const parentInput = String(options.parent);
				parentId = normalizeTaskId(parentInput);
				baseFilters.parentTaskId = parentInput;
			}

			if (options.sort) {
				const validSortFields = ["priority", "id"];
				const sortField = options.sort.toLowerCase();
				if (!validSortFields.includes(sortField)) {
					console.error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
					process.exitCode = 1;
					cleanup();
					return;
				}
			}

			const usePlainOutput = isPlainLocal(options) || shouldAutoPlain;
			if (usePlainOutput) {
				const tasks = await core.queryTasks({ filters: baseFilters, includeCrossBranch: false });
				const config = await core.filesystem.loadConfig();

				if (parentId) {
					const parentExists = (await core.queryTasks({ includeCrossBranch: false })).some((task) =>
						taskIdsEqual(parentId, task.id),
					);
					if (!parentExists) {
						console.error(`Parent task ${parentId} not found.`);
						process.exitCode = 1;
						cleanup();
						return;
					}
				}

				let sortedTasks = tasks;
				if (options.sort) {
					const validSortFields = ["priority", "id"];
					const sortField = options.sort.toLowerCase();
					if (!validSortFields.includes(sortField)) {
						console.error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
						process.exitCode = 1;
						cleanup();
						return;
					}
					sortedTasks = sortTasks(tasks, sortField);
				} else {
					sortedTasks = sortTasks(tasks, "priority");
				}

				let filtered = sortedTasks;
				if (parentId) {
					filtered = filtered.filter((task) => task.parentTaskId && taskIdsEqual(parentId, task.parentTaskId));
				}

				if (filtered.length === 0) {
					if (options.parent) {
						const canonicalParent = normalizeTaskId(String(options.parent));
						console.log(`No child tasks found for parent task ${canonicalParent}.`);
					} else {
						console.log("No tasks found.");
					}
					cleanup();
					return;
				}

				if (options.sort && options.sort.toLowerCase() === "priority") {
					const sortedByPriority = sortTasks(filtered, "priority");
					console.log("Tasks (sorted by priority):");
					for (const t of sortedByPriority) {
						const priorityIndicator = t.priority ? `[${t.priority.toUpperCase()}] ` : "";
						const statusIndicator = t.status ? ` (${t.status})` : "";
						console.log(`  ${priorityIndicator}${t.id} - ${t.title}${statusIndicator}`);
					}
					cleanup();
					return;
				}

				const canonicalByLower = new Map<string, string>();
				const statuses = config?.statuses || [];
				for (const status of statuses) {
					canonicalByLower.set(status.toLowerCase(), status);
				}

				const groups = new Map<string, Task[]>();
				for (const task of filtered) {
					const rawStatus = (task.status || "").trim();
					const canonicalStatus = canonicalByLower.get(rawStatus.toLowerCase()) || rawStatus;
					const list = groups.get(canonicalStatus) || [];
					list.push(task);
					groups.set(canonicalStatus, list);
				}

				const orderedStatuses = [
					...statuses.filter((status) => groups.has(status)),
					...Array.from(groups.keys()).filter((status) => !statuses.includes(status)),
				];

				for (const status of orderedStatuses) {
					const list = groups.get(status);
					if (!list) continue;
					let sortedList = list;
					if (options.sort) {
						sortedList = sortTasks(list, options.sort.toLowerCase());
					}
					console.log(`${status || "No Status"}:`);
					sortedList.forEach((task) => {
						const priorityIndicator = task.priority ? `[${task.priority.toUpperCase()}] ` : "";
						console.log(`  ${priorityIndicator}${task.id} - ${task.title}`);
					});
					console.log();
				}
				cleanup();
				return;
			}

			let filterDescription = "";
			let title = "Tasks";
			const activeFilters: string[] = [];
			if (options.status) activeFilters.push(`Status: ${options.status}`);
			if (options.assignee) activeFilters.push(`Assignee: ${options.assignee}`);
			if (options.parent) {
				activeFilters.push(`Parent: ${normalizeTaskId(String(options.parent))}`);
			}
			if (options.priority) activeFilters.push(`Priority: ${options.priority}`);
			if (options.sort) activeFilters.push(`Sort: ${options.sort}`);

			if (activeFilters.length > 0) {
				filterDescription = activeFilters.join(", ");
				title = `Tasks (${activeFilters.join(" • ")})`;
			}

			const { runUnifiedView } = await import("../ui/unified-view.ts");
			await runUnifiedView({
				core,
				initialView: "task-list",
				tasksLoader: async (updateProgress) => {
					updateProgress("Loading configuration...");
					const config = await core.filesystem.loadConfig();

					// Use loadTasks with progress callback for consistent loading experience
					// This populates the ContentStore, so subsequent queryTasks calls are fast
					await core.loadTasks((msg) => {
						updateProgress(msg);
					});

					// Now query with filters - this will use the already-populated ContentStore
					updateProgress("Applying filters...");
					const [tasks, allTasksForParentCheck] = await Promise.all([
						core.queryTasks({ filters: baseFilters }),
						parentId ? core.queryTasks() : Promise.resolve(undefined),
					]);

					if (parentId && allTasksForParentCheck) {
						const parentExists = allTasksForParentCheck.some((task) => taskIdsEqual(parentId, task.id));
						if (!parentExists) {
							throw new Error(`Parent task ${parentId} not found.`);
						}
					}

					let sortedTasks = tasks;
					if (options.sort) {
						const validSortFields = ["priority", "id"];
						const sortField = options.sort.toLowerCase();
						if (!validSortFields.includes(sortField)) {
							throw new Error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
						}
						sortedTasks = sortTasks(tasks, sortField);
					} else {
						sortedTasks = sortTasks(tasks, "priority");
					}

					let filtered = sortedTasks;
					if (parentId) {
						filtered = filtered.filter((task) => task.parentTaskId && taskIdsEqual(parentId, task.parentTaskId));
					}

					return {
						tasks: filtered,
						statuses: config?.statuses || [],
					};
				},
				filter: {
					status: options.status,
					assignee: options.assignee,
					priority: options.priority,
					sort: options.sort,
					title,
					filterDescription,
					parentTaskId: parentId,
				},
			});
			cleanup();
		});

	taskCmd
		.command("edit <taskId>")
		.description("edit an existing task")
		.option("-t, --title <title>")
		.option(
			"-d, --description <text>",
			"task description (multi-line: bash $'Line1\\nLine2', POSIX printf, PowerShell \"Line1`nLine2\")",
		)
		.option("--desc <text>", "alias for --description")
		.option("-a, --assignee <assignee>")
		.option("-s, --status <status>")
		.option("-l, --label <labels>")
		.option("--priority <priority>", "set task priority (high, medium, low)")
		.option("--ordinal <number>", "set task ordinal for custom ordering")
		.option("--plain", "use plain text output after editing")
		.option("--add-label <label>")
		.option("--remove-label <label>")
		.option("--ac <criteria>", "add acceptance criteria (can be used multiple times)", createMultiValueAccumulator())
		.option("--dod <item>", "add Definition of Done item (can be used multiple times)", createMultiValueAccumulator())
		.option(
			"--remove-ac <index>",
			"remove acceptance criterion by index (1-based, can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option(
			"--remove-dod <index>",
			"remove Definition of Done item by index (1-based, can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option(
			"--check-ac <index>",
			"check acceptance criterion by index (1-based, can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option(
			"--check-dod <index>",
			"check Definition of Done item by index (1-based, can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option(
			"--uncheck-ac <index>",
			"uncheck acceptance criterion by index (1-based, can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option(
			"--uncheck-dod <index>",
			"uncheck Definition of Done item by index (1-based, can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option("--acceptance-criteria <criteria>", "set acceptance criteria (comma-separated or use multiple times)")
		.option("--plan <text>", "set implementation plan")
		.option("--notes <text>", "set implementation notes (replaces existing)")
		.option("--final-summary <text>", "set final summary (replaces existing)")
		.option(
			"--append-notes <text>",
			"append to implementation notes (can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option(
			"--append-final-summary <text>",
			"append to final summary (can be used multiple times)",
			createMultiValueAccumulator(),
		)
		.option("--clear-final-summary", "remove final summary")
		.option(
			"--depends-on <taskIds>",
			"set task dependencies (comma-separated or use multiple times)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.option(
			"--dep <taskIds>",
			"set task dependencies (shortcut for --depends-on)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.option(
			"--ref <reference>",
			"set references (can be used multiple times)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.option(
			"--doc <documentation>",
			"set documentation (can be used multiple times)",
			(value: string, previous: string | string[]) => {
				const soFar = Array.isArray(previous) ? previous : previous ? [previous] : [];
				return [...soFar, value];
			},
		)
		.action(async (taskId: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const canonicalId = normalizeTaskId(taskId);
			const existingTask = await core.loadTaskById(canonicalId);

			if (!existingTask) {
				console.error(`Task ${taskId} not found.`);
				process.exitCode = 1;
				return;
			}

			const parseCommaSeparated = (value: unknown): string[] => {
				return toStringArray(value)
					.flatMap((entry) => String(entry).split(","))
					.map((entry) => entry.trim())
					.filter((entry) => entry.length > 0);
			};

			let canonicalStatus: string | undefined;
			if (options.status) {
				const canonical = await getCanonicalStatus(String(options.status), core);
				if (!canonical) {
					const configuredStatuses = await getValidStatuses(core);
					console.error(
						`Invalid status: ${options.status}. Valid statuses are: ${formatValidStatuses(configuredStatuses)}`,
					);
					process.exitCode = 1;
					return;
				}
				canonicalStatus = canonical;
			}

			let normalizedPriority: "high" | "medium" | "low" | undefined;
			if (options.priority) {
				const priority = String(options.priority).toLowerCase();
				const validPriorities = ["high", "medium", "low"] as const;
				if (!validPriorities.includes(priority as (typeof validPriorities)[number])) {
					console.error(`Invalid priority: ${priority}. Valid values are: high, medium, low`);
					process.exitCode = 1;
					return;
				}
				normalizedPriority = priority as "high" | "medium" | "low";
			}

			let ordinalValue: number | undefined;
			if (options.ordinal !== undefined) {
				const parsed = Number(options.ordinal);
				if (Number.isNaN(parsed) || parsed < 0) {
					console.error(`Invalid ordinal: ${options.ordinal}. Must be a non-negative number.`);
					process.exitCode = 1;
					return;
				}
				ordinalValue = parsed;
			}

			let removeCriteria: number[] | undefined;
			let checkCriteria: number[] | undefined;
			let uncheckCriteria: number[] | undefined;
			let removeDod: number[] | undefined;
			let checkDod: number[] | undefined;
			let uncheckDod: number[] | undefined;

			try {
				const removes = parsePositiveIndexList(options.removeAc);
				if (removes.length > 0) {
					removeCriteria = removes;
				}
				const checks = parsePositiveIndexList(options.checkAc);
				if (checks.length > 0) {
					checkCriteria = checks;
				}
				const unchecks = parsePositiveIndexList(options.uncheckAc);
				if (unchecks.length > 0) {
					uncheckCriteria = unchecks;
				}
				const dodRemoves = parsePositiveIndexList(options.removeDod);
				if (dodRemoves.length > 0) {
					removeDod = dodRemoves;
				}
				const dodChecks = parsePositiveIndexList(options.checkDod);
				if (dodChecks.length > 0) {
					checkDod = dodChecks;
				}
				const dodUnchecks = parsePositiveIndexList(options.uncheckDod);
				if (dodUnchecks.length > 0) {
					uncheckDod = dodUnchecks;
				}
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
				return;
			}

			const labelValues = parseCommaSeparated(options.label);
			const addLabelValues = parseCommaSeparated(options.addLabel);
			const removeLabelValues = parseCommaSeparated(options.removeLabel);
			const assigneeValues = parseCommaSeparated(options.assignee);
			const acceptanceAdditions = processAcceptanceCriteriaOptions(options);
			const definitionOfDoneAdditions = toStringArray(options.dod)
				.map((value) => String(value).trim())
				.filter((value) => value.length > 0);

			const combinedDependencies = [...toStringArray(options.dependsOn), ...toStringArray(options.dep)];
			const dependencyValues =
				combinedDependencies.length > 0 ? normalizeDependencies(combinedDependencies) : undefined;

			const referenceValues = toStringArray(options.ref);
			const normalizedReferences =
				referenceValues.length > 0
					? normalizeStringList(
							referenceValues.flatMap((r: string) =>
								String(r)
									.split(",")
									.map((s: string) => s.trim()),
							),
						)
					: undefined;

			const documentationValues = toStringArray(options.doc);
			const normalizedDocumentation =
				documentationValues.length > 0
					? normalizeStringList(
							documentationValues.flatMap((d: string) =>
								String(d)
									.split(",")
									.map((s: string) => s.trim()),
							),
						)
					: undefined;

			const notesAppendValues = toStringArray(options.appendNotes);
			const finalSummaryAppendValues = toStringArray(options.appendFinalSummary);

			const editArgs: TaskEditArgs = {};
			if (options.title) {
				editArgs.title = String(options.title);
			}
			const descriptionOption = options.description ?? options.desc;
			if (descriptionOption !== undefined) {
				editArgs.description = String(descriptionOption);
			}
			if (canonicalStatus) {
				editArgs.status = canonicalStatus;
			}
			if (normalizedPriority) {
				editArgs.priority = normalizedPriority;
			}
			if (ordinalValue !== undefined) {
				editArgs.ordinal = ordinalValue;
			}
			if (labelValues.length > 0) {
				editArgs.labels = labelValues;
			}
			if (addLabelValues.length > 0) {
				editArgs.addLabels = addLabelValues;
			}
			if (removeLabelValues.length > 0) {
				editArgs.removeLabels = removeLabelValues;
			}
			if (assigneeValues.length > 0) {
				editArgs.assignee = assigneeValues;
			}
			if (dependencyValues && dependencyValues.length > 0) {
				editArgs.dependencies = dependencyValues;
			}
			if (normalizedReferences && normalizedReferences.length > 0) {
				editArgs.references = normalizedReferences;
			}
			if (normalizedDocumentation && normalizedDocumentation.length > 0) {
				editArgs.documentation = normalizedDocumentation;
			}
			if (typeof options.plan === "string") {
				editArgs.planSet = String(options.plan);
			}
			if (typeof options.notes === "string") {
				editArgs.notesSet = String(options.notes);
			}
			if (notesAppendValues.length > 0) {
				editArgs.notesAppend = notesAppendValues;
			}
			if (typeof options.finalSummary === "string") {
				editArgs.finalSummary = String(options.finalSummary);
			}
			if (finalSummaryAppendValues.length > 0) {
				editArgs.finalSummaryAppend = finalSummaryAppendValues;
			}
			if (options.clearFinalSummary) {
				editArgs.finalSummaryClear = true;
			}
			if (acceptanceAdditions.length > 0) {
				editArgs.acceptanceCriteriaAdd = acceptanceAdditions;
			}
			if (removeCriteria) {
				editArgs.acceptanceCriteriaRemove = removeCriteria;
			}
			if (checkCriteria) {
				editArgs.acceptanceCriteriaCheck = checkCriteria;
			}
			if (uncheckCriteria) {
				editArgs.acceptanceCriteriaUncheck = uncheckCriteria;
			}
			if (definitionOfDoneAdditions.length > 0) {
				editArgs.definitionOfDoneAdd = definitionOfDoneAdditions;
			}
			if (removeDod) {
				editArgs.definitionOfDoneRemove = removeDod;
			}
			if (checkDod) {
				editArgs.definitionOfDoneCheck = checkDod;
			}
			if (uncheckDod) {
				editArgs.definitionOfDoneUncheck = uncheckDod;
			}

			let updatedTask: Task;
			try {
				const updateInput = buildTaskUpdateInput(editArgs);
				updatedTask = await core.editTask(canonicalId, updateInput);
			} catch (error) {
				console.error(error instanceof Error ? error.message : String(error));
				process.exitCode = 1;
				return;
			}

			const usePlainOutput = isPlainLocal(options);
			if (usePlainOutput) {
				console.log(formatTaskPlainText(updatedTask));
				return;
			}

			console.log(`Updated task ${updatedTask.id}`);
		});

	// Note: Implementation notes appending is handled via `task edit --append-notes` only.

	taskCmd
		.command("view <taskId>")
		.description("display task details")
		.option("--plain", "use plain text output instead of interactive UI")
		.action(async (taskId: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const localTasks = await core.fs.listTasks();
			const task = await core.getTaskWithSubtasks(taskId, localTasks);
			if (!task) {
				console.error(`Task ${taskId} not found.`);
				return;
			}

			const allTasks = localTasks.some((candidate) => taskIdsEqual(task.id, candidate.id))
				? localTasks
				: [...localTasks, task];

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainLocal(options) || shouldAutoPlain;
			if (usePlainOutput) {
				console.log(formatTaskPlainText(task));
				return;
			}

			// Use enhanced task viewer with detail focus
			await viewTaskEnhanced(task, { startWithDetailFocus: true, core, tasks: allTasks });
		});

	taskCmd
		.command("archive <taskId>")
		.description("archive a task")
		.action(async (taskId: string) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const success = await core.archiveTask(taskId);
			if (success) {
				console.log(`Archived task ${taskId}`);
			} else {
				console.error(`Task ${taskId} not found.`);
			}
		});

	taskCmd
		.command("demote <taskId>")
		.description("move task back to drafts")
		.action(async (taskId: string) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const success = await core.demoteTask(taskId);
			if (success) {
				console.log(`Demoted task ${taskId}`);
			} else {
				console.error(`Task ${taskId} not found.`);
			}
		});

	taskCmd
		.argument("[taskId]")
		.option("--plain", "use plain text output")
		.action(async (taskId: string | undefined, options: { plain?: boolean }) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);

			// Don't handle commands that should be handled by specific command handlers
			const reservedCommands = ["create", "list", "edit", "view", "archive", "demote"];
			if (taskId && reservedCommands.includes(taskId)) {
				console.error(`Unknown command: ${taskId}`);
				taskCmd.help();
				return;
			}

			// Handle single task view only
			if (!taskId) {
				taskCmd.help();
				return;
			}

			const localTasks = await core.fs.listTasks();
			const task = await core.getTaskWithSubtasks(taskId, localTasks);
			if (!task) {
				console.error(`Task ${taskId} not found.`);
				return;
			}

			const allTasks = localTasks.some((candidate) => taskIdsEqual(task.id, candidate.id))
				? localTasks
				: [...localTasks, task];

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainLocal(options) || shouldAutoPlain;
			if (usePlainOutput) {
				console.log(formatTaskPlainText(task));
				return;
			}

			// Use unified view with detail focus and Tab switching support
			const { runUnifiedView } = await import("../ui/unified-view.ts");
			await runUnifiedView({
				core,
				initialView: "task-detail",
				selectedTask: task,
				tasks: allTasks,
			});
		});
}
