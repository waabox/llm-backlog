import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import { formatTaskPlainText } from "../formatters/task-plain-text.ts";
import { EntityType } from "../types/index.ts";
import { viewTaskEnhanced } from "../ui/task-viewer-with-search.ts";
import { isPlainRequested, requireProjectRoot } from "./shared.ts";
import { buildTaskFromOptions } from "./task-helpers.ts";

/**
 * Register the draft command group for managing draft tasks.
 *
 * @param program - Commander program instance
 */
export function registerDraftCommand(program: Command): void {
	const shouldAutoPlain = !(process.stdout.isTTY && process.stdin.isTTY);

	const draftCmd = program.command("draft");

	draftCmd
		.command("list")
		.description("list all drafts")
		.option("--sort <field>", "sort drafts by field (priority, id)")
		.option("--plain", "use plain text output")
		.action(async (options: { plain?: boolean; sort?: string }) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			await core.ensureConfigLoaded();
			const drafts = await core.filesystem.listDrafts();

			if (!drafts || drafts.length === 0) {
				console.log("No drafts found.");
				return;
			}

			// Apply sorting - default to priority sorting like the web UI
			const { sortTasks } = await import("../utils/task-sorting.ts");
			let sortedDrafts = drafts;

			if (options.sort) {
				const validSortFields = ["priority", "id"];
				const sortField = options.sort.toLowerCase();
				if (!validSortFields.includes(sortField)) {
					console.error(`Invalid sort field: ${options.sort}. Valid values are: priority, id`);
					process.exitCode = 1;
					return;
				}
				sortedDrafts = sortTasks(drafts, sortField);
			} else {
				// Default to priority sorting to match web UI behavior
				sortedDrafts = sortTasks(drafts, "priority");
			}

			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				// Plain text output for non-interactive environments
				console.log("Drafts:");
				for (const draft of sortedDrafts) {
					const priorityIndicator = draft.priority ? `[${draft.priority.toUpperCase()}] ` : "";
					console.log(`  ${priorityIndicator}${draft.id} - ${draft.title}`);
				}
			} else {
				// Interactive UI - use unified view with draft support
				const firstDraft = sortedDrafts[0];
				if (!firstDraft) return;

				const { runUnifiedView } = await import("../ui/unified-view.ts");
				await runUnifiedView({
					core,
					initialView: "task-list",
					selectedTask: firstDraft,
					tasks: sortedDrafts,
					filter: {
						filterDescription: "All Drafts",
					},
					title: "Drafts",
				});
			}
		});

	draftCmd
		.command("create <title>")
		.option(
			"-d, --description <text>",
			"task description (multi-line: bash $'Line1\\nLine2', POSIX printf, PowerShell \"Line1`nLine2\")",
		)
		.option("--desc <text>", "alias for --description")
		.option("-a, --assignee <assignee>")
		.option("-s, --status <status>")
		.option("-l, --labels <labels>")
		.action(async (title: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			await core.ensureConfigLoaded();
			const id = await core.generateNextId(EntityType.Draft);
			const task = buildTaskFromOptions(id, title, options);
			const filepath = await core.createDraft(task);
			console.log(`Created draft ${id}`);
			console.log(`File: ${filepath}`);
		});

	draftCmd
		.command("archive <taskId>")
		.description("archive a draft")
		.action(async (taskId: string) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const success = await core.archiveDraft(taskId);
			if (success) {
				console.log(`Archived draft ${taskId}`);
			} else {
				console.error(`Draft ${taskId} not found.`);
			}
		});

	draftCmd
		.command("promote <taskId>")
		.description("promote draft to task")
		.action(async (taskId: string) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const success = await core.promoteDraft(taskId);
			if (success) {
				console.log(`Promoted draft ${taskId}`);
			} else {
				console.error(`Draft ${taskId} not found.`);
			}
		});

	draftCmd
		.command("view <taskId>")
		.description("display draft details")
		.option("--plain", "use plain text output instead of interactive UI")
		.action(async (taskId: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const { getDraftPath } = await import("../utils/task-path.ts");
			const filePath = await getDraftPath(taskId, core);

			if (!filePath) {
				console.error(`Draft ${taskId} not found.`);
				return;
			}
			const draft = await core.filesystem.loadDraft(taskId);

			if (!draft) {
				console.error(`Draft ${taskId} not found.`);
				return;
			}

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				console.log(formatTaskPlainText(draft));
				return;
			}

			// Use enhanced task viewer with detail focus
			await viewTaskEnhanced(draft, { startWithDetailFocus: true, core });
		});

	draftCmd
		.argument("[taskId]")
		.option("--plain", "use plain text output")
		.action(async (taskId: string | undefined, options: { plain?: boolean }) => {
			if (!taskId) {
				draftCmd.help();
				return;
			}

			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const { getDraftPath } = await import("../utils/task-path.ts");
			const filePath = await getDraftPath(taskId, core);

			if (!filePath) {
				console.error(`Draft ${taskId} not found.`);
				return;
			}
			const draft = await core.filesystem.loadDraft(taskId);

			if (!draft) {
				console.error(`Draft ${taskId} not found.`);
				return;
			}

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				console.log(formatTaskPlainText(draft, { filePathOverride: filePath }));
				return;
			}

			// Use enhanced task viewer with detail focus
			await viewTaskEnhanced(draft, { startWithDetailFocus: true, core });
		});
}
