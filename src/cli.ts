#!/usr/bin/env node

import { Command } from "commander";
import { registerCompletionCommand } from "./commands/completion.ts";
import { registerMcpCommand } from "./commands/mcp.ts";
import { Core } from "./index.ts";
import { findBacklogRoot } from "./utils/find-backlog-root.ts";
import { getVersion } from "./utils/version.ts";

// Windows color fix
if (process.platform === "win32") {
	const term = process.env.TERM;
	if (!term || /^(xterm|dumb|ansi|vt100)$/i.test(term)) {
		process.env.TERM = "xterm-256color";
	}
}

// Temporarily isolate BUN_OPTIONS during CLI parsing to prevent conflicts
// Save the original value so it's available for subsequent commands
const originalBunOptions = process.env.BUN_OPTIONS;
if (process.env.BUN_OPTIONS) {
	delete process.env.BUN_OPTIONS;
}

// Get version from package.json
const version = await getVersion();

// Bare-run splash screen handling (before Commander parses commands)
// Show a welcome splash when invoked without subcommands, unless help/version requested
try {
	let rawArgs = process.argv.slice(2);
	// Some package managers (e.g., Bun global shims) may inject the resolved
	// binary path as the first non-node argument. Strip it if detected.
	if (rawArgs.length > 0) {
		const first = rawArgs[0];
		if (
			typeof first === "string" &&
			/node_modules[\\/]+backlog\.md-(darwin|linux|windows)-[^\\/]+[\\/]+backlog(\.exe)?$/.test(first)
		) {
			rawArgs = rawArgs.slice(1);
		}
	}
	const wantsHelp = rawArgs.includes("-h") || rawArgs.includes("--help");
	const wantsVersion = rawArgs.includes("-v") || rawArgs.includes("--version");
	// Treat only --plain as allowed flag for splash; any other args means use normal CLI parsing
	const onlyPlain = rawArgs.length === 1 && rawArgs[0] === "--plain";
	const isBare = rawArgs.length === 0 || onlyPlain;
	if (isBare && !wantsHelp && !wantsVersion) {
		const isTTY = !!process.stdout.isTTY;
		const forcePlain = rawArgs.includes("--plain");
		const noColor = !!process.env.NO_COLOR || !isTTY;

		let initialized = false;
		try {
			const projectRoot = await findBacklogRoot(process.cwd());
			if (projectRoot) {
				const core = new Core(projectRoot);
				const cfg = await core.filesystem.loadConfig();
				initialized = !!cfg;
			}
		} catch {
			initialized = false;
		}

		const { printSplash } = await import("./ui/splash.ts");
		// Auto-fallback to plain when non-TTY, or explicit --plain, or if terminal very narrow
		const termWidth = Math.max(0, Number(process.stdout.columns || 0));
		const autoPlain = !isTTY || (termWidth > 0 && termWidth < 60);
		await printSplash({
			version,
			initialized,
			plain: forcePlain || autoPlain,
			color: !noColor,
		});
		// Ensure we don't enter Commander command parsing
		process.exit(0);
	}
} catch {
	// Fall through to normal CLI parsing on any splash error
}

// Global config migration - run before any command processing
// Only run if we're in a backlog project (skip for init, help, version)
const shouldRunMigration =
	!process.argv.includes("init") &&
	!process.argv.includes("--help") &&
	!process.argv.includes("-h") &&
	!process.argv.includes("--version") &&
	!process.argv.includes("-v") &&
	process.argv.length > 2; // Ensure we have actual commands

if (shouldRunMigration) {
	try {
		const projectRoot = await findBacklogRoot(process.cwd());
		if (projectRoot) {
			const core = new Core(projectRoot);

			// Only migrate if config already exists (project is already initialized)
			const config = await core.filesystem.loadConfig();
			if (config) {
				await core.ensureConfigMigrated();
			}
		}
	} catch (_error) {
		// Silently ignore migration errors - project might not be initialized yet
	}
}

const program = new Command();
program
	.name("backlog")
	.description("Backlog.md - Project management CLI")
	.version(version, "-v, --version", "display version number");

// Register all command groups
const { registerInitCommand } = await import("./commands/init.ts");
const { registerTaskCommand } = await import("./commands/task.ts");
const { registerSearchCommand } = await import("./commands/search.ts");
const { registerDraftCommand } = await import("./commands/draft.ts");
const { registerMilestoneCommand } = await import("./commands/milestone.ts");
const { registerBoardCommand } = await import("./commands/board.ts");
const { registerDocCommand } = await import("./commands/doc.ts");
const { registerDecisionCommand } = await import("./commands/decision.ts");
const { registerAgentsCommand } = await import("./commands/agents.ts");
const { registerConfigCommand } = await import("./commands/config.ts");
const { registerSequenceCommand } = await import("./commands/sequence.ts");
const { registerCleanupCommand } = await import("./commands/cleanup.ts");
const { registerBrowserCommand } = await import("./commands/browser.ts");
const { registerOverviewCommand } = await import("./commands/overview.ts");

registerInitCommand(program);
registerTaskCommand(program);
registerSearchCommand(program);
registerDraftCommand(program);
registerMilestoneCommand(program);
registerBoardCommand(program);
registerDocCommand(program);
registerDecisionCommand(program);
registerAgentsCommand(program);
registerConfigCommand(program);
registerSequenceCommand(program);
registerCleanupCommand(program);
registerBrowserCommand(program);
registerOverviewCommand(program);
registerCompletionCommand(program);
registerMcpCommand(program);

program.parseAsync(process.argv).finally(() => {
	// Restore BUN_OPTIONS after CLI parsing completes so it's available for subsequent commands
	if (originalBunOptions) {
		process.env.BUN_OPTIONS = originalBunOptions;
	}
});
