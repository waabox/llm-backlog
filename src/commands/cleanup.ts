import { basename, join } from "node:path";
import type { Command } from "commander";
import prompts from "prompts";
import { Core } from "../core/backlog.ts";
import { requireProjectRoot } from "./shared.ts";

/**
 * Register the cleanup command for moving completed tasks to the completed folder.
 *
 * @param program - Commander program instance
 */
export function registerCleanupCommand(program: Command): void {
	program
		.command("cleanup")
		.description("move completed tasks to completed folder based on age")
		.action(async () => {
			try {
				const cwd = await requireProjectRoot();
				const core = new Core(cwd);

				// Check if backlog project is initialized
				const config = await core.filesystem.loadConfig();
				if (!config) {
					console.error("No backlog project found. Initialize one first with: backlog init");
					process.exit(1);
				}

				// Get all Done tasks
				const tasks = await core.queryTasks();
				const doneTasks = tasks.filter((task) => task.status === "Done");

				if (doneTasks.length === 0) {
					console.log("No completed tasks found to clean up.");
					return;
				}

				console.log(`Found ${doneTasks.length} tasks marked as Done.`);

				const ageOptions = [
					{ title: "1 day", value: 1 },
					{ title: "1 week", value: 7 },
					{ title: "2 weeks", value: 14 },
					{ title: "3 weeks", value: 21 },
					{ title: "1 month", value: 30 },
					{ title: "3 months", value: 90 },
					{ title: "1 year", value: 365 },
				];

				const { selectedAge } = await prompts({
					type: "select",
					name: "selectedAge",
					message: "Move tasks to completed folder if they are older than:",
					choices: ageOptions,
					hint: "Tasks in completed folder are still accessible but won't clutter the main board",
				});

				if (selectedAge === undefined) {
					console.log("Cleanup cancelled.");
					return;
				}

				// Get tasks older than selected period
				const tasksToMove = await core.getDoneTasksByAge(selectedAge);

				if (tasksToMove.length === 0) {
					console.log(`No tasks found that are older than ${ageOptions.find((o) => o.value === selectedAge)?.title}.`);
					return;
				}

				console.log(
					`\nFound ${tasksToMove.length} tasks older than ${ageOptions.find((o) => o.value === selectedAge)?.title}:`,
				);
				for (const task of tasksToMove.slice(0, 5)) {
					const date = task.updatedDate || task.createdDate;
					console.log(`  - ${task.id}: ${task.title} (${date})`);
				}
				if (tasksToMove.length > 5) {
					console.log(`  ... and ${tasksToMove.length - 5} more`);
				}

				const { confirmed } = await prompts({
					type: "confirm",
					name: "confirmed",
					message: `Move ${tasksToMove.length} tasks to completed folder?`,
					initial: false,
				});

				if (!confirmed) {
					console.log("Cleanup cancelled.");
					return;
				}

				// Move tasks to completed folder
				let successCount = 0;
				const shouldAutoCommit = config.autoCommit ?? false;

				console.log("Moving tasks...");
				const movedTasks: Array<{ fromPath: string; toPath: string; taskId: string }> = [];

				for (const task of tasksToMove) {
					const fromPath = task.filePath ?? (await core.getTask(task.id))?.filePath ?? null;

					if (!fromPath) {
						console.error(`Failed to locate file for task ${task.id}`);
						continue;
					}

					const taskFilename = basename(fromPath);
					const toPath = join(core.filesystem.completedDir, taskFilename);

					const success = await core.completeTask(task.id);
					if (success) {
						successCount++;
						movedTasks.push({ fromPath, toPath, taskId: task.id });
					} else {
						console.error(`Failed to move task ${task.id}`);
					}
				}

				// If autoCommit is disabled, stage the moves so Git recognizes them
				if (successCount > 0 && !shouldAutoCommit) {
					console.log("Staging file moves for Git...");
					for (const { fromPath, toPath } of movedTasks) {
						try {
							await core.gitOps.stageFileMove(fromPath, toPath);
						} catch (error) {
							console.warn(`Warning: Could not stage move for Git: ${error}`);
						}
					}
				}

				console.log(`Successfully moved ${successCount} of ${tasksToMove.length} tasks to completed folder.`);
				if (successCount > 0 && !shouldAutoCommit) {
					console.log("Files have been staged. To commit: git commit -m 'cleanup: Move completed tasks'");
				}
			} catch (err) {
				console.error("Failed to run cleanup", err);
				process.exitCode = 1;
			}
		});
}
