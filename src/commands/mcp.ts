/**
 * MCP Command Group - Model Context Protocol CLI commands.
 *
 * Supports two transports:
 * - stdio (default): for local MCP integration with editors
 * - HTTP (--http): for remote/multi-user access with optional API key auth
 */

import type { Command } from "commander";
import { createMcpHttpServer } from "../mcp/http-transport.ts";
import { createMcpServer } from "../mcp/server.ts";
import { ConfigRepoService } from "../server/auth/config-repo.ts";

type StartOptions = {
	debug?: boolean;
	http?: boolean;
	port?: string;
};

/**
 * Register MCP command group with CLI program.
 *
 * @param program - Commander program instance
 */
export function registerMcpCommand(program: Command): void {
	const mcpCmd = program.command("mcp");
	registerStartCommand(mcpCmd);
}

/**
 * Register 'mcp start' command supporting both stdio and HTTP transports.
 */
function registerStartCommand(mcpCmd: Command): void {
	mcpCmd
		.command("start")
		.description("Start the MCP server")
		.option("-d, --debug", "Enable debug logging", false)
		.option("--http", "Use HTTP transport instead of stdio", false)
		.option("--port <number>", "Port for HTTP server", "3001")
		.action(async (options: StartOptions) => {
			if (options.http) {
				await startHttpMode(options);
			} else {
				await startStdioMode(options);
			}
		});
}

/**
 * Starts the MCP server in stdio transport mode.
 *
 * This is the default mode used for local editor integrations.
 *
 * @param options CLI start options
 */
async function startStdioMode(options: StartOptions): Promise<void> {
	try {
		const server = await createMcpServer(process.cwd(), {
			debug: options.debug,
		});

		await server.connect();
		await server.start();

		if (options.debug) {
			console.error("Backlog.md MCP server started (stdio transport)");
		}

		let shutdownTriggered = false;
		const shutdown = async (signal: string) => {
			if (shutdownTriggered) {
				return;
			}
			shutdownTriggered = true;
			if (options.debug) {
				console.error(`Received ${signal}, shutting down MCP server...`);
			}

			try {
				await server.stop();
				process.exit(0);
			} catch (error) {
				console.error("Error during MCP server shutdown:", error);
				process.exit(1);
			}
		};

		const handleStdioClose = () => shutdown("stdio");
		process.stdin.once("end", handleStdioClose);
		process.stdin.once("close", handleStdioClose);

		const handlePipeError = (error: unknown) => {
			const code =
				error && typeof error === "object" && "code" in error ? String((error as { code?: string }).code ?? "") : "";
			if (code === "EPIPE") {
				void shutdown("EPIPE");
			}
		};
		process.stdout.once("error", handlePipeError);
		process.stderr.once("error", handlePipeError);

		process.once("SIGINT", () => shutdown("SIGINT"));
		process.once("SIGTERM", () => shutdown("SIGTERM"));
		if (process.platform !== "win32") {
			process.once("SIGHUP", () => shutdown("SIGHUP"));
			process.once("SIGPIPE", () => shutdown("SIGPIPE"));
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to start MCP server: ${message}`);
		process.exit(1);
	}
}

/**
 * Starts the MCP server in HTTP transport mode with optional API key auth.
 *
 * When the AUTH_CONFIG_REPO environment variable is set, authentication is
 * enabled via a config repo that provides user/API-key lookups. Without it,
 * the server runs unauthenticated.
 *
 * @param options CLI start options including port
 */
async function startHttpMode(options: StartOptions): Promise<void> {
	try {
		const port = Number.parseInt(options.port ?? "3001", 10);
		const configRepoUrl = process.env.AUTH_CONFIG_REPO;
		let configRepoService: ConfigRepoService | undefined;
		let authEnabled = false;

		if (configRepoUrl) {
			configRepoService = new ConfigRepoService(configRepoUrl);
			await configRepoService.start();
			authEnabled = true;
			if (options.debug) {
				console.error("Auth enabled via config repo");
			}
		} else if (options.debug) {
			console.error("Auth disabled (AUTH_CONFIG_REPO not set)");
		}

		const { url, stop } = await createMcpHttpServer({
			projectRoot: process.cwd(),
			port,
			authEnabled,
			findUserByApiKey:
				authEnabled && configRepoService
					? (key: string) => configRepoService?.findUserByApiKey(key) ?? null
					: undefined,
			debug: options.debug,
		});

		console.error(`MCP HTTP server running at ${url}/mcp`);
		if (authEnabled) {
			console.error("Authentication: API key required (Bearer token)");
		} else {
			console.error("Authentication: disabled");
		}

		let shutdownTriggered = false;
		const shutdown = async () => {
			if (shutdownTriggered) return;
			shutdownTriggered = true;
			if (options.debug) {
				console.error("Shutting down MCP HTTP server...");
			}
			try {
				await stop();
				if (configRepoService) {
					await configRepoService.stop();
				}
				process.exit(0);
			} catch (error) {
				console.error("Error during shutdown:", error);
				process.exit(1);
			}
		};

		process.once("SIGINT", () => shutdown());
		process.once("SIGTERM", () => shutdown());
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Failed to start MCP HTTP server: ${message}`);
		process.exit(1);
	}
}
