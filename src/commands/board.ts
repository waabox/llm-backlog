import { join } from "node:path";
import { stdin as input } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import { collectArchivedMilestoneKeys, milestoneKey, resolveMilestoneInput } from "../core/milestones.ts";
import { exportKanbanBoardToFile, updateReadmeWithBoard } from "../index.ts";
import type { Task } from "../types/index.ts";
import { createLoadingScreen } from "../ui/loading.ts";
import { getVersion } from "../utils/version.ts";
import { requireProjectRoot } from "./shared.ts";

/**
 * Add the common board display options to a command.
 */
function addBoardOptions(cmd: Command): Command {
	return cmd
		.option("-l, --layout <layout>", "board layout (horizontal|vertical)", "horizontal")
		.option("--vertical", "use vertical layout (shortcut for --layout vertical)")
		.option("-m, --milestones", "group tasks by milestone");
}

/**
 * Shared handler for the board view (used by both the bare and the explicit
 * "view" subcommand).
 */
async function handleBoardView(options: { layout?: string; vertical?: boolean; milestones?: boolean }): Promise<void> {
	const cwd = await requireProjectRoot();
	const core = new Core(cwd);
	const config = await core.filesystem.loadConfig();

	const _layout = options.vertical ? "vertical" : (options.layout as "horizontal" | "vertical") || "horizontal";
	const _maxColumnWidth = config?.maxColumnWidth || 20;
	const statuses = config?.statuses || [];

	// Use unified view for Tab switching support
	const { runUnifiedView } = await import("../ui/unified-view.ts");
	await runUnifiedView({
		core,
		initialView: "kanban",
		milestoneMode: options.milestones,
		tasksLoader: async (updateProgress) => {
			const [tasks, milestoneEntities, archivedMilestones] = await Promise.all([
				core.loadTasks((msg) => {
					updateProgress(msg);
				}),
				core.filesystem.listMilestones(),
				core.filesystem.listArchivedMilestones(),
			]);
			const archivedKeys = new Set(collectArchivedMilestoneKeys(archivedMilestones, milestoneEntities));
			const normalizedTasks =
				archivedKeys.size > 0
					? tasks.map((task) => {
							const key = milestoneKey(
								resolveMilestoneInput(task.milestone ?? "", milestoneEntities, archivedMilestones),
							);
							if (!key || !archivedKeys.has(key)) {
								return task;
							}
							return { ...task, milestone: undefined };
						})
					: tasks;
			return {
				tasks: normalizedTasks.map((t) => ({ ...t, status: t.status || "" })),
				statuses,
			};
		},
	});
}

/**
 * Register the board command group for displaying and exporting the Kanban board.
 *
 * @param program - Commander program instance
 */
export function registerBoardCommand(program: Command): void {
	const boardCmd = program.command("board");

	addBoardOptions(boardCmd).description("display tasks in a Kanban board").action(handleBoardView);

	addBoardOptions(boardCmd.command("view").description("display tasks in a Kanban board")).action(handleBoardView);

	boardCmd
		.command("export [filename]")
		.description("export kanban board to markdown file")
		.option("--force", "overwrite existing file without confirmation")
		.option("--readme", "export to README.md with markers")
		.option("--export-version <version>", "version to include in the export")
		.action(async (filename, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const config = await core.filesystem.loadConfig();
			const statuses = config?.statuses || [];

			// Load tasks with progress tracking
			const loadingScreen = await createLoadingScreen("Loading tasks for export");

			let finalTasks: Task[];
			try {
				// Use the shared Core method for loading board tasks
				finalTasks = await core.loadTasks((msg) => {
					loadingScreen?.update(msg);
				});

				loadingScreen?.update(`Total tasks: ${finalTasks.length}`);

				// Close loading screen before export
				loadingScreen?.close();

				// Get project name from config or use directory name
				const { basename } = await import("node:path");
				const projectName = config?.projectName || basename(cwd);

				if (options.readme) {
					// Use version from option if provided, otherwise use the CLI version
					const version = await getVersion();
					const exportVersion = options.exportVersion || version;
					await updateReadmeWithBoard(finalTasks, statuses, projectName, exportVersion);
					console.log("Updated README.md with Kanban board.");
				} else {
					// Use filename argument or default to Backlog.md
					const outputFile = filename || "Backlog.md";
					const outputPath = join(cwd, outputFile as string);

					// Check if file exists and handle overwrite confirmation
					const fileExists = await Bun.file(outputPath).exists();
					if (fileExists && !options.force) {
						const rl = createInterface({ input });
						try {
							const answer = await rl.question(`File "${outputPath}" already exists. Overwrite? (y/N): `);
							if (!answer.toLowerCase().startsWith("y")) {
								console.log("Export cancelled.");
								return;
							}
						} finally {
							rl.close();
						}
					}

					await exportKanbanBoardToFile(finalTasks, statuses, outputPath, projectName, options.force || !fileExists);
					console.log(`Exported board to ${outputPath}`);
				}
			} catch (error) {
				loadingScreen?.close();
				throw error;
			}
		});
}
