import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import { computeSequences } from "../core/sequences.ts";
import { isPlainRequested, requireProjectRoot } from "./shared.ts";

/**
 * Register the sequence command group for listing and inspecting execution sequences.
 *
 * @param program - Commander program instance
 */
export function registerSequenceCommand(program: Command): void {
	const shouldAutoPlain = !(process.stdout.isTTY && process.stdin.isTTY);

	const sequenceCmd = program.command("sequence");

	sequenceCmd
		.description("list and inspect execution sequences computed from task dependencies")
		.command("list")
		.description("list sequences (interactive by default; use --plain for text output)")
		.option("--plain", "use plain text output instead of interactive UI")
		.action(async (options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const tasks = await core.queryTasks();
			// Exclude tasks marked as Done from sequences (case-insensitive)
			const activeTasks = tasks.filter((t) => (t.status || "").toLowerCase() !== "done");
			const { unsequenced, sequences } = computeSequences(activeTasks);

			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				if (unsequenced.length > 0) {
					console.log("Unsequenced:");
					for (const t of unsequenced) {
						console.log(`  ${t.id} - ${t.title}`);
					}
					console.log("");
				}
				for (const seq of sequences) {
					console.log(`Sequence ${seq.index}:`);
					for (const t of seq.tasks) {
						console.log(`  ${t.id} - ${t.title}`);
					}
					console.log("");
				}
				return;
			}

			// Interactive default: TUI view (215.01 + 215.02 navigation/detail)
			const { runSequencesView } = await import("../ui/sequences.ts");
			await runSequencesView({ unsequenced, sequences }, core);
		});
}
