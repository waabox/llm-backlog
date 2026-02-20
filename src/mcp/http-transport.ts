/**
 * HTTP transport for the MCP server.
 *
 * Wraps the MCP server with API key authentication and role-based tool
 * filtering. Uses Bun.serve() with the MCP SDK's
 * WebStandardStreamableHTTPServerTransport in stateless mode, meaning every
 * request creates a fresh transport (sessionIdGenerator: undefined).
 *
 * All MCP traffic is served on a single /mcp route. Authentication is opt-in:
 * when authEnabled is false all tools are available without credentials.
 *
 * @author waabox(waabox[at]gmail[dot]com)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { extractBearerToken } from "../server/auth/middleware.ts";
import type { AuthUser } from "../server/auth/users-store.ts";
import { getPackageName } from "../utils/app-info.ts";
import { getVersion } from "../utils/version.ts";
import { filterToolsByRole } from "./auth/tool-filter.ts";
import { createMcpServer } from "./server.ts";
import type { McpPromptHandler, McpResourceHandler, McpToolHandler } from "./types.ts";

export type McpRequestHandlerOptions = {
	projectRoot: string;
	authEnabled: boolean;
	findUserByApiKey?: (apiKey: string) => AuthUser | null;
	debug?: boolean;
};

/**
 * Reusable MCP request handler that can be embedded in any HTTP server.
 *
 * Handles authentication, per-request tool filtering by role, and delegates
 * to a stateless MCP transport. Designed to be called from both the standalone
 * HTTP server and BacklogServer's fetch handler.
 */
export type McpRequestHandler = {
	handleRequest: (req: Request) => Promise<Response>;
	stop: () => Promise<void>;
};

/**
 * Creates a reusable MCP request handler without starting its own HTTP server.
 *
 * For each authenticated request a fresh Server + transport pair is created,
 * with only the tools allowed for the caller's role registered. Resources and
 * prompts are passed through without filtering.
 *
 * @param options Handler configuration including project root and auth settings.
 * @returns A handler object with handleRequest and stop methods.
 */
export async function createMcpRequestHandler(options: McpRequestHandlerOptions): Promise<McpRequestHandler> {
	const { projectRoot, authEnabled, findUserByApiKey, debug } = options;

	const mcpServer = await createMcpServer(projectRoot, { debug });
	const appName = getPackageName();
	const appVersion = await getVersion();

	async function handleRequest(req: Request): Promise<Response> {
		// Auth check
		let userRole: "admin" | "viewer" | undefined;
		if (authEnabled) {
			const url = new URL(req.url);
			const token =
				extractBearerToken(req.headers.get("Authorization")) ?? url.searchParams.get("token");
			if (!token || !findUserByApiKey) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}
			const user = findUserByApiKey(token);
			if (!user) {
				return Response.json({ error: "Unauthorized" }, { status: 401 });
			}
			userRole = user.role;
		}

		// Get tools filtered by role, plus all resources and prompts
		const allTools = mcpServer.getTools();
		const filteredTools = filterToolsByRole(allTools, userRole);
		const allResources = mcpServer.getResources();
		const allPrompts = mcpServer.getPrompts();

		// Create a per-request Server with only the permitted tools
		const perRequestServer = new Server(
			{ name: appName, version: appVersion },
			{
				capabilities: {
					tools: {},
					resources: {},
					prompts: {},
				},
			},
		);

		registerToolHandlers(perRequestServer, filteredTools);
		registerResourceHandlers(perRequestServer, allResources);
		registerPromptHandlers(perRequestServer, allPrompts);

		// Create stateless transport and handle the request
		const transport = new WebStandardStreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
		});

		await perRequestServer.connect(transport);
		return transport.handleRequest(req);
	}

	return {
		handleRequest,
		stop: async () => {
			await mcpServer.stop();
		},
	};
}

export type McpHttpServerOptions = McpRequestHandlerOptions & {
	port: number;
};

/**
 * Creates a standalone HTTP server that exposes the MCP protocol.
 *
 * Wraps createMcpRequestHandler with its own Bun.serve() instance.
 * Used by `backlog mcp start --http` for standalone MCP hosting.
 *
 * @param options Server configuration including port, project root, and auth settings.
 * @returns An object with the server URL, port, and a stop function.
 */
export async function createMcpHttpServer(options: McpHttpServerOptions): Promise<{
	url: string;
	port: number;
	stop: () => Promise<void>;
}> {
	const { port, ...handlerOptions } = options;
	const handler = await createMcpRequestHandler(handlerOptions);

	const bunServer = Bun.serve({
		port,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);
			if (url.pathname !== "/mcp") {
				return new Response("Not Found", { status: 404 });
			}
			return handler.handleRequest(req);
		},
	});

	// Bun always assigns a port (random when 0), but the type is number | undefined
	const assignedPort = bunServer.port ?? port;
	const url = `http://localhost:${assignedPort}`;
	if (handlerOptions.debug) {
		console.error(`MCP HTTP server listening on ${url}/mcp`);
	}

	return {
		url,
		port: assignedPort,
		stop: async () => {
			bunServer.stop(true);
			await handler.stop();
		},
	};
}

// ---------------------------------------------------------------------------
// Handler registration helpers
// ---------------------------------------------------------------------------

function registerToolHandlers(server: Server, tools: McpToolHandler[]): void {
	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: tools.map((t) => ({
			name: t.name,
			description: t.description,
			inputSchema: { type: "object" as const, ...t.inputSchema },
		})),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args = {} } = request.params;
		const tool = tools.find((t) => t.name === name);
		if (!tool) {
			throw new Error(`Tool not found: ${name}`);
		}
		return await tool.handler(args);
	});
}

function registerResourceHandlers(server: Server, resources: McpResourceHandler[]): void {
	server.setRequestHandler(ListResourcesRequestSchema, async () => ({
		resources: resources.map((r) => ({
			uri: r.uri,
			name: r.name || "Unnamed Resource",
			description: r.description,
			mimeType: r.mimeType,
		})),
	}));

	server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
		resourceTemplates: [],
	}));

	server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
		const { uri } = request.params;
		let resource = resources.find((r) => r.uri === uri);
		if (!resource) {
			const baseUri = uri.split("?")[0] || uri;
			resource = resources.find((r) => r.uri === baseUri);
		}
		if (!resource) {
			throw new Error(`Resource not found: ${uri}`);
		}
		return await resource.handler(uri);
	});
}

function registerPromptHandlers(server: Server, prompts: McpPromptHandler[]): void {
	server.setRequestHandler(ListPromptsRequestSchema, async () => ({
		prompts: prompts.map((p) => ({
			name: p.name,
			description: p.description,
			arguments: p.arguments,
		})),
	}));

	server.setRequestHandler(GetPromptRequestSchema, async (request) => {
		const { name, arguments: args = {} } = request.params;
		const prompt = prompts.find((p) => p.name === name);
		if (!prompt) {
			throw new Error(`Prompt not found: ${name}`);
		}
		return await prompt.handler(args);
	});
}
