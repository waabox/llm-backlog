import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import { requireProjectRoot } from "./shared.ts";

/**
 * Register the browser command for the web-based task management UI.
 *
 * @param program - Commander program instance
 */
export function registerBrowserCommand(program: Command): void {
	program
		.command("browser")
		.description("open browser interface for task management (press Ctrl+C or Cmd+C to stop)")
		.option("-p, --port <port>", "port to run server on")
		.option("--no-open", "don't automatically open browser")
		.action(async (options) => {
			try {
				const cwd = await requireProjectRoot();
				const { BacklogServer } = await import("../server/index.ts");
				const server = new BacklogServer(cwd);

				// Load config to get default port
				const core = new Core(cwd);
				const config = await core.filesystem.loadConfig();
				const defaultPort = config?.defaultPort ?? 6420;

				const port = Number.parseInt(options.port || defaultPort.toString(), 10);
				if (Number.isNaN(port) || port < 1 || port > 65535) {
					console.error("Invalid port number. Must be between 1 and 65535.");
					process.exit(1);
				}

				await server.start(port, options.open !== false);

				// Graceful shutdown on common termination signals (register once)
				let shuttingDown = false;
				const shutdown = async (signal: string) => {
					if (shuttingDown) return;
					shuttingDown = true;
					console.log(`\nReceived ${signal}. Shutting down server...`);
					try {
						const stopPromise = server.stop();
						const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
						await Promise.race([stopPromise, timeout]);
					} finally {
						process.exit(0);
					}
				};

				process.once("SIGINT", () => void shutdown("SIGINT"));
				process.once("SIGTERM", () => void shutdown("SIGTERM"));
				process.once("SIGQUIT", () => void shutdown("SIGQUIT"));
			} catch (err) {
				console.error("Failed to start browser interface", err);
				process.exitCode = 1;
			}
		});
}
