import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import {
	type DecisionSearchResult,
	type DocumentSearchResult,
	isLocalEditableTask,
	type SearchPriorityFilter,
	type SearchResult,
	type SearchResultType,
	type TaskSearchResult,
} from "../types/index.ts";
import { hasAnyPrefix } from "../utils/prefix-config.ts";
import { createMultiValueAccumulator, isPlainRequested, requireProjectRoot } from "./shared.ts";

function buildSearchFilterDescription(filters: {
	status?: string;
	priority?: SearchPriorityFilter;
	query?: string;
}): string {
	const parts: string[] = [];
	if (filters.query) {
		parts.push(`Query: ${filters.query}`);
	}
	if (filters.status) {
		parts.push(`Status: ${filters.status}`);
	}
	if (filters.priority) {
		parts.push(`Priority: ${filters.priority}`);
	}
	return parts.join(" • ");
}

function printSearchResults(results: SearchResult[]): void {
	if (results.length === 0) {
		console.log("No results found.");
		return;
	}

	const tasks: TaskSearchResult[] = [];
	const documents: DocumentSearchResult[] = [];
	const decisions: DecisionSearchResult[] = [];

	for (const result of results) {
		if (result.type === "task") {
			tasks.push(result);
			continue;
		}
		if (result.type === "document") {
			documents.push(result);
			continue;
		}
		decisions.push(result);
	}

	const localTasks = tasks.filter((t) => isLocalEditableTask(t.task));

	let printed = false;

	if (localTasks.length > 0) {
		console.log("Tasks:");
		for (const taskResult of localTasks) {
			const { task } = taskResult;
			const scoreText = formatScore(taskResult.score);
			const statusText = task.status ? ` (${task.status})` : "";
			const priorityText = task.priority ? ` [${task.priority.toUpperCase()}]` : "";
			console.log(`  ${task.id} - ${task.title}${statusText}${priorityText}${scoreText}`);
		}
		printed = true;
	}

	if (documents.length > 0) {
		if (printed) {
			console.log("");
		}
		console.log("Documents:");
		for (const documentResult of documents) {
			const { document } = documentResult;
			const scoreText = formatScore(documentResult.score);
			console.log(`  ${document.id} - ${document.title}${scoreText}`);
		}
		printed = true;
	}

	if (decisions.length > 0) {
		if (printed) {
			console.log("");
		}
		console.log("Decisions:");
		for (const decisionResult of decisions) {
			const { decision } = decisionResult;
			const scoreText = formatScore(decisionResult.score);
			console.log(`  ${decision.id} - ${decision.title}${scoreText}`);
		}
		printed = true;
	}

	if (!printed) {
		console.log("No results found.");
	}
}

function formatScore(score: number | null): string {
	if (score === null || score === undefined) {
		return "";
	}
	// Invert score so higher is better (Fuse.js uses 0=perfect match, 1=no match)
	const invertedScore = 1 - score;
	return ` [score ${invertedScore.toFixed(3)}]`;
}

function isTaskSearchResult(result: SearchResult): result is TaskSearchResult {
	return result.type === "task";
}

/**
 * Register the top-level search command for searching tasks, documents, and decisions.
 *
 * @param program - Commander program instance
 */
export function registerSearchCommand(program: Command): void {
	const hasInteractiveTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
	const shouldAutoPlain = !hasInteractiveTTY;
	const plainFlagInArgv = process.argv.includes("--plain");

	function isPlainLocal(options?: { plain?: boolean }): boolean {
		return isPlainRequested(options, plainFlagInArgv);
	}

	program
		.command("search [query]")
		.description("search tasks, documents, and decisions using the shared index")
		.option("--type <type>", "limit results to type (task, document, decision)", createMultiValueAccumulator())
		.option("--status <status>", "filter task results by status")
		.option("--priority <priority>", "filter task results by priority (high, medium, low)")
		.option("--limit <number>", "limit total results returned")
		.option("--plain", "print plain text output instead of interactive UI")
		.action(async (query: string | undefined, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const searchService = await core.getSearchService();
			const contentStore = await core.getContentStore();
			const cleanup = () => {
				searchService.dispose();
				contentStore.dispose();
			};

			const rawTypes = options.type ? (Array.isArray(options.type) ? options.type : [options.type]) : undefined;
			const allowedTypes: SearchResultType[] = ["task", "document", "decision"];
			const types = rawTypes
				? rawTypes
						.map((value: string) => value.toLowerCase())
						.filter((value: string): value is SearchResultType => {
							if (!allowedTypes.includes(value as SearchResultType)) {
								console.warn(`Ignoring unsupported type '${value}'. Supported: task, document, decision`);
								return false;
							}
							return true;
						})
				: allowedTypes;

			const filters: { status?: string; priority?: SearchPriorityFilter } = {};
			if (options.status) {
				filters.status = options.status;
			}
			if (options.priority) {
				const priorityLower = String(options.priority).toLowerCase();
				const validPriorities: SearchPriorityFilter[] = ["high", "medium", "low"];
				if (!validPriorities.includes(priorityLower as SearchPriorityFilter)) {
					console.error("Invalid priority. Valid values: high, medium, low");
					cleanup();
					process.exitCode = 1;
					return;
				}
				filters.priority = priorityLower as SearchPriorityFilter;
			}

			let limit: number | undefined;
			if (options.limit !== undefined) {
				const parsed = Number.parseInt(String(options.limit), 10);
				if (Number.isNaN(parsed) || parsed <= 0) {
					console.error("--limit must be a positive integer");
					cleanup();
					process.exitCode = 1;
					return;
				}
				limit = parsed;
			}

			const searchResults = searchService.search({
				query: query ?? "",
				limit,
				types,
				filters,
			});

			const usePlainOutput = isPlainLocal(options) || shouldAutoPlain;
			if (usePlainOutput) {
				printSearchResults(searchResults);
				cleanup();
				return;
			}

			const taskResults = searchResults.filter(isTaskSearchResult);
			const searchResultTasks = taskResults.map((result) => result.task);

			const allTasks = (await core.queryTasks()).filter(
				(task) => task.id && task.id.trim() !== "" && hasAnyPrefix(task.id),
			);

			// If no tasks exist at all, show plain text results
			if (allTasks.length === 0) {
				printSearchResults(searchResults);
				cleanup();
				return;
			}

			// Use the first search result as the selected task, or first available task if no results
			const firstTask = searchResultTasks[0] || allTasks[0];
			const priorityFilter = filters.priority ? filters.priority : undefined;
			const statusFilter = filters.status;
			const { runUnifiedView } = await import("../ui/unified-view.ts");

			await runUnifiedView({
				core,
				initialView: "task-list",
				selectedTask: firstTask,
				tasks: allTasks, // Pass ALL tasks, not just search results
				filter: {
					title: query ? `Search: ${query}` : "Search",
					filterDescription: buildSearchFilterDescription({
						status: statusFilter,
						priority: priorityFilter,
						query: query ?? "",
					}),
					status: statusFilter,
					priority: priorityFilter,
					searchQuery: query ?? "", // Pre-populate search with the query
				},
			});
			cleanup();
		});
}
