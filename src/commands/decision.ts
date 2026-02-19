import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import type { Decision } from "../types/index.ts";
import { generateNextDecisionId } from "../utils/id-generators.ts";
import { requireProjectRoot } from "./shared.ts";

/**
 * Register the decision command group for managing architectural decision records.
 *
 * @param program - Commander program instance
 */
export function registerDecisionCommand(program: Command): void {
	const decisionCmd = program.command("decision");

	decisionCmd
		.command("create <title>")
		.option("-s, --status <status>")
		.action(async (title: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const id = await generateNextDecisionId(core);
			const decision: Decision = {
				id,
				title: title as string,
				date: new Date().toISOString().slice(0, 16).replace("T", " "),
				status: (options.status || "proposed") as Decision["status"],
				context: "",
				decision: "",
				consequences: "",
				rawContent: "",
			};
			await core.createDecision(decision);
			console.log(`Created decision ${id}`);
		});
}
