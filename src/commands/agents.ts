import type { Command } from "commander";
import prompts from "prompts";
import { type AgentInstructionFile, addAgentInstructions } from "../agent-instructions.ts";
import { Core } from "../core/backlog.ts";
import { requireProjectRoot } from "./shared.ts";

/**
 * Register the agents command group for managing agent instruction files.
 *
 * @param program - Commander program instance
 */
export function registerAgentsCommand(program: Command): void {
	const agentsCmd = program.command("agents");

	agentsCmd
		.description("manage agent instruction files")
		.option(
			"--update-instructions",
			"update agent instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, .github/copilot-instructions.md)",
		)
		.action(async (options) => {
			if (!options.updateInstructions) {
				agentsCmd.help();
				return;
			}
			try {
				const cwd = await requireProjectRoot();
				const core = new Core(cwd);

				// Check if backlog project is initialized
				const config = await core.filesystem.loadConfig();
				if (!config) {
					console.error("No backlog project found. Initialize one first with: backlog init");
					process.exit(1);
				}

				const _agentOptions = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", ".github/copilot-instructions.md"] as const;

				const { files: selected } = await prompts({
					type: "multiselect",
					name: "files",
					message: "Select agent instruction files to update",
					choices: [
						{ title: "CLAUDE.md (Claude Code)", value: "CLAUDE.md" },
						{ title: "AGENTS.md (Codex, Jules, Amp, Cursor, Zed, Warp, Aider, GitHub, RooCode)", value: "AGENTS.md" },
						{ title: "GEMINI.md (Google CLI)", value: "GEMINI.md" },
						{ title: "Copilot (GitHub Copilot)", value: ".github/copilot-instructions.md" },
					],
					hint: "Space to select, Enter to confirm\n",
					instructions: false,
				});

				const files: AgentInstructionFile[] = (selected ?? []) as AgentInstructionFile[];

				if (files.length > 0) {
					// Get autoCommit setting from config
					const config = await core.filesystem.loadConfig();
					const shouldAutoCommit = config?.autoCommit ?? false;
					await addAgentInstructions(cwd, core.gitOps, files, shouldAutoCommit);
					console.log(`Updated ${files.length} agent instruction file(s): ${files.join(", ")}`);
				} else {
					console.log("No files selected for update.");
				}
			} catch (err) {
				console.error("Failed to update agent instructions", err);
				process.exitCode = 1;
			}
		});
}
