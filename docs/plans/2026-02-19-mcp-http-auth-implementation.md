# MCP HTTP Transport with Auth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add HTTP transport to the MCP server with API key authentication and role-based tool filtering, so AI tools can connect remotely to a server they don't have direct access to.

**Architecture:** Extend the existing MCP server to support an HTTP transport mode alongside stdio. Reuse ConfigRepoService and UsersStore from Gmail OAuth, extending UsersStore with API key lookup. Use the MCP SDK's `WebStandardStreamableHTTPServerTransport` in stateless mode with `Bun.serve()`. Filter visible tools by role at the protocol level.

**Tech Stack:** TypeScript, Bun, `@modelcontextprotocol/sdk` v1.26.0 (`WebStandardStreamableHTTPServerTransport`), existing auth modules

---

### Task 1: Extend UsersStore with API Key Lookup

**Files:**
- Modify: `src/server/auth/users-store.ts`
- Modify: `src/server/auth/users-store.test.ts`

**Context:** The `UsersStore` currently parses `users.md` YAML frontmatter and provides `findByEmail()`. We need to add an optional `apiKey` field to `AuthUser` and a `findByApiKey()` method with its own index.

**Step 1: Add tests for API key support**

Add to `src/server/auth/users-store.test.ts`:

```typescript
it("parses apiKey field from user entries", async () => {
	const filePath = join(testDir, "users.md");
	await Bun.write(
		filePath,
		[
			"---",
			"users:",
			"  - email: admin@example.com",
			"    name: Admin User",
			"    role: admin",
			"    apiKey: bkmd_admin123",
			"  - email: viewer@example.com",
			"    name: Viewer User",
			"    role: viewer",
			"    apiKey: bkmd_viewer456",
			"---",
		].join("\n"),
	);

	const store = new UsersStore(filePath);
	await store.load();

	const admin = store.findByApiKey("bkmd_admin123");
	expect(admin).not.toBeNull();
	expect(admin?.email).toBe("admin@example.com");
	expect(admin?.role).toBe("admin");

	const viewer = store.findByApiKey("bkmd_viewer456");
	expect(viewer).not.toBeNull();
	expect(viewer?.email).toBe("viewer@example.com");
	expect(viewer?.role).toBe("viewer");
});

it("returns null for unknown API key", async () => {
	const filePath = join(testDir, "users.md");
	await Bun.write(
		filePath,
		[
			"---",
			"users:",
			"  - email: admin@example.com",
			"    name: Admin User",
			"    role: admin",
			"    apiKey: bkmd_admin123",
			"---",
		].join("\n"),
	);

	const store = new UsersStore(filePath);
	await store.load();

	expect(store.findByApiKey("bkmd_unknown")).toBeNull();
	expect(store.findByApiKey("")).toBeNull();
});

it("handles users without apiKey field", async () => {
	const filePath = join(testDir, "users.md");
	await Bun.write(
		filePath,
		[
			"---",
			"users:",
			"  - email: no-key@example.com",
			"    name: No Key User",
			"    role: admin",
			"  - email: has-key@example.com",
			"    name: Has Key User",
			"    role: viewer",
			"    apiKey: bkmd_haskey789",
			"---",
		].join("\n"),
	);

	const store = new UsersStore(filePath);
	await store.load();

	const hasKey = store.findByApiKey("bkmd_haskey789");
	expect(hasKey).not.toBeNull();
	expect(hasKey?.email).toBe("has-key@example.com");

	// Users without apiKey are still found by email
	const noKey = store.findByEmail("no-key@example.com");
	expect(noKey).not.toBeNull();
});
```

**Step 2: Run tests to verify they fail**

Run: `CLAUDECODE=1 npx -y bun test src/server/auth/users-store.test.ts --timeout 30000`
Expected: FAIL — `findByApiKey` does not exist

**Step 3: Implement API key support**

Modify `src/server/auth/users-store.ts`:

1. Add optional `apiKey` field to `AuthUser`:
```typescript
export interface AuthUser {
	email: string;
	name: string;
	role: "admin" | "viewer";
	apiKey?: string;
}
```

2. Add a second `Map` for API key index:
```typescript
private apiKeys = new Map<string, AuthUser>();
```

3. In `load()`, clear both maps and index entries that have an apiKey:
```typescript
async load(): Promise<void> {
	this.users.clear();
	this.apiKeys.clear();
	// ... existing parsing ...
	// After creating the user object, if entry.apiKey is a non-empty string:
	const apiKey = typeof entry.apiKey === "string" ? entry.apiKey.trim() : "";
	const user: AuthUser = { email, name, role, ...(apiKey.length > 0 ? { apiKey } : {}) };
	this.users.set(email.toLowerCase(), user);
	if (apiKey.length > 0) {
		this.apiKeys.set(apiKey, user);
	}
}
```

4. Add `findByApiKey()`:
```typescript
findByApiKey(apiKey: string): AuthUser | null {
	if (apiKey.length === 0) return null;
	return this.apiKeys.get(apiKey) ?? null;
}
```

**Step 4: Run tests to verify they pass**

Run: `CLAUDECODE=1 npx -y bun test src/server/auth/users-store.test.ts --timeout 30000`
Expected: All 9 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/users-store.ts src/server/auth/users-store.test.ts
git commit -m "Extend UsersStore with API key lookup for MCP auth"
```

---

### Task 2: Extend ConfigRepoService with API Key Lookup

**Files:**
- Modify: `src/server/auth/config-repo.ts`
- Modify: `src/server/auth/config-repo.test.ts`

**Context:** `ConfigRepoService` delegates to `UsersStore`. Add a `findUserByApiKey()` method.

**Step 1: Add test for API key lookup via ConfigRepoService**

Add to `src/server/auth/config-repo.test.ts`:

```typescript
it("finds a user by API key", async () => {
	const usersContent = [
		"---",
		"users:",
		"  - email: admin@example.com",
		"    name: Admin User",
		"    role: admin",
		"    apiKey: bkmd_testapikey123",
		"---",
	].join("\n");

	await Bun.write(join(remoteDir, "users.md"), usersContent);
	await $`git -C ${remoteDir} add users.md && git -C ${remoteDir} commit -m "add users with apiKey"`.quiet();

	const service = new ConfigRepoService(remoteDir);
	await service.start();
	try {
		const user = service.findUserByApiKey("bkmd_testapikey123");
		expect(user).not.toBeNull();
		expect(user?.email).toBe("admin@example.com");
		expect(user?.role).toBe("admin");

		const unknown = service.findUserByApiKey("bkmd_unknown");
		expect(unknown).toBeNull();
	} finally {
		await service.stop();
	}
});
```

**Step 2: Run tests to verify they fail**

Run: `CLAUDECODE=1 npx -y bun test src/server/auth/config-repo.test.ts --timeout 30000`
Expected: FAIL — `findUserByApiKey` does not exist

**Step 3: Implement findUserByApiKey**

Add to `src/server/auth/config-repo.ts`:

```typescript
findUserByApiKey(apiKey: string): AuthUser | null {
	return this.usersStore?.findByApiKey(apiKey) ?? null;
}
```

**Step 4: Run tests to verify they pass**

Run: `CLAUDECODE=1 npx -y bun test src/server/auth/config-repo.test.ts --timeout 30000`
Expected: All 4 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/config-repo.ts src/server/auth/config-repo.test.ts
git commit -m "Add findUserByApiKey to ConfigRepoService"
```

---

### Task 3: Tool Role Filter

**Files:**
- Create: `src/mcp/auth/tool-filter.ts`
- Create: `src/mcp/auth/tool-filter.test.ts`

**Context:** Classify MCP tools as read-only or write (admin-only). Provide a function that filters a tool list by role. Read-only tools: names containing `_list`, `_search`, `_view`, or starting with `get_`. All workflow tools are read-only. Everything else is write.

**Step 1: Write tests**

Create `src/mcp/auth/tool-filter.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { filterToolsByRole, isReadOnlyTool } from "./tool-filter.ts";
import type { McpToolHandler } from "../types.ts";

function makeTool(name: string): McpToolHandler {
	return {
		name,
		description: `Test tool: ${name}`,
		inputSchema: {},
		handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

describe("isReadOnlyTool", () => {
	it("classifies list/search/view tools as read-only", () => {
		expect(isReadOnlyTool("task_list")).toBe(true);
		expect(isReadOnlyTool("task_search")).toBe(true);
		expect(isReadOnlyTool("task_view")).toBe(true);
		expect(isReadOnlyTool("document_list")).toBe(true);
		expect(isReadOnlyTool("document_view")).toBe(true);
		expect(isReadOnlyTool("document_search")).toBe(true);
		expect(isReadOnlyTool("milestone_list")).toBe(true);
	});

	it("classifies workflow tools as read-only", () => {
		expect(isReadOnlyTool("get_workflow_overview")).toBe(true);
		expect(isReadOnlyTool("get_task_creation_guide")).toBe(true);
		expect(isReadOnlyTool("get_task_execution_guide")).toBe(true);
		expect(isReadOnlyTool("get_task_finalization_guide")).toBe(true);
	});

	it("classifies create/edit/archive/complete/update/add/rename/remove tools as write", () => {
		expect(isReadOnlyTool("task_create")).toBe(false);
		expect(isReadOnlyTool("task_edit")).toBe(false);
		expect(isReadOnlyTool("task_archive")).toBe(false);
		expect(isReadOnlyTool("task_complete")).toBe(false);
		expect(isReadOnlyTool("document_create")).toBe(false);
		expect(isReadOnlyTool("document_update")).toBe(false);
		expect(isReadOnlyTool("milestone_add")).toBe(false);
		expect(isReadOnlyTool("milestone_rename")).toBe(false);
		expect(isReadOnlyTool("milestone_remove")).toBe(false);
		expect(isReadOnlyTool("milestone_archive")).toBe(false);
	});
});

describe("filterToolsByRole", () => {
	const allTools = [
		makeTool("task_list"),
		makeTool("task_create"),
		makeTool("task_view"),
		makeTool("task_edit"),
		makeTool("document_list"),
		makeTool("document_create"),
		makeTool("get_workflow_overview"),
	];

	it("returns all tools for admin", () => {
		const filtered = filterToolsByRole(allTools, "admin");
		expect(filtered.length).toBe(allTools.length);
	});

	it("returns only read-only tools for viewer", () => {
		const filtered = filterToolsByRole(allTools, "viewer");
		const names = filtered.map((t) => t.name);
		expect(names).toContain("task_list");
		expect(names).toContain("task_view");
		expect(names).toContain("document_list");
		expect(names).toContain("get_workflow_overview");
		expect(names).not.toContain("task_create");
		expect(names).not.toContain("task_edit");
		expect(names).not.toContain("document_create");
	});

	it("returns all tools when role is undefined (no auth)", () => {
		const filtered = filterToolsByRole(allTools, undefined);
		expect(filtered.length).toBe(allTools.length);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `CLAUDECODE=1 npx -y bun test src/mcp/auth/tool-filter.test.ts --timeout 30000`
Expected: FAIL — module not found

**Step 3: Implement tool filter**

Create `src/mcp/auth/tool-filter.ts`:

```typescript
import type { McpToolHandler } from "../types.ts";

const READ_ONLY_SUFFIXES = ["_list", "_search", "_view"];
const READ_ONLY_PREFIXES = ["get_"];

/**
 * Determines if an MCP tool is read-only based on its name.
 * Read-only tools: list, search, view operations and workflow guides.
 * Write tools: create, edit, archive, complete, update, add, rename, remove.
 */
export function isReadOnlyTool(toolName: string): boolean {
	for (const suffix of READ_ONLY_SUFFIXES) {
		if (toolName.endsWith(suffix)) return true;
	}
	for (const prefix of READ_ONLY_PREFIXES) {
		if (toolName.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Filters a list of tools based on the user's role.
 * Admin gets all tools. Viewer gets only read-only tools.
 * If role is undefined (no auth), all tools are returned.
 */
export function filterToolsByRole(
	tools: McpToolHandler[],
	role: "admin" | "viewer" | undefined,
): McpToolHandler[] {
	if (role === undefined || role === "admin") {
		return tools;
	}
	return tools.filter((tool) => isReadOnlyTool(tool.name));
}
```

**Step 4: Run tests to verify they pass**

Run: `CLAUDECODE=1 npx -y bun test src/mcp/auth/tool-filter.test.ts --timeout 30000`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/mcp/auth/tool-filter.ts src/mcp/auth/tool-filter.test.ts
git commit -m "Add role-based MCP tool filter"
```

---

### Task 4: HTTP Transport for McpServer

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `src/mcp/http-transport.ts`
- Create: `src/mcp/http-transport.test.ts`

**Context:** Add an HTTP serving mode to the MCP server using `WebStandardStreamableHTTPServerTransport` from the MCP SDK in stateless mode. This module creates a `Bun.serve()` instance that routes `/mcp` to the MCP transport, with API key auth middleware.

**Step 1: Write tests**

Create `src/mcp/http-transport.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthUser } from "../server/auth/users-store.ts";
import { createMcpHttpServer, type McpHttpServerOptions } from "./http-transport.ts";

const TEST_DIR_PREFIX = join(tmpdir(), "backlog-mcp-http-test-");

describe("MCP HTTP Transport", () => {
	let testDir: string;
	let stopServer: (() => Promise<void>) | null = null;

	beforeEach(async () => {
		testDir = await mkdtemp(TEST_DIR_PREFIX);
		// Create minimal backlog structure
		await Bun.write(join(testDir, "backlog", "config.json"), JSON.stringify({ prefix: "TEST", nextId: 1 }));
	});

	afterEach(async () => {
		if (stopServer) {
			await stopServer();
			stopServer = null;
		}
		await rm(testDir, { recursive: true, force: true }).catch(() => {});
	});

	it("rejects requests without auth when auth is enabled", async () => {
		const findUser = (_key: string): AuthUser | null => null;
		const { url, stop } = await createMcpHttpServer({
			projectRoot: testDir,
			port: 0,
			authEnabled: true,
			findUserByApiKey: findUser,
		});
		stopServer = stop;

		const response = await fetch(`${url}/mcp`, { method: "POST" });
		expect(response.status).toBe(401);
	});

	it("rejects requests with invalid API key", async () => {
		const findUser = (_key: string): AuthUser | null => null;
		const { url, stop } = await createMcpHttpServer({
			projectRoot: testDir,
			port: 0,
			authEnabled: true,
			findUserByApiKey: findUser,
		});
		stopServer = stop;

		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { Authorization: "Bearer bkmd_invalid" },
		});
		expect(response.status).toBe(401);
	});

	it("allows requests without auth when auth is disabled", async () => {
		const { url, stop } = await createMcpHttpServer({
			projectRoot: testDir,
			port: 0,
			authEnabled: false,
		});
		stopServer = stop;

		// MCP initialize request
		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "test", version: "1.0" },
				},
			}),
		});
		// Should get a valid MCP response (200), not an auth error
		expect(response.status).toBe(200);
	});
});
```

**Step 2: Run tests to verify they fail**

Run: `CLAUDECODE=1 npx -y bun test src/mcp/http-transport.test.ts --timeout 30000`
Expected: FAIL — module not found

**Step 3: Implement HTTP transport**

Create `src/mcp/http-transport.ts`:

```typescript
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AuthUser } from "../server/auth/users-store.ts";
import { createMcpServer } from "./server.ts";
import { filterToolsByRole } from "./auth/tool-filter.ts";
import { extractBearerToken } from "../server/auth/middleware.ts";

export type McpHttpServerOptions = {
	projectRoot: string;
	port: number;
	authEnabled: boolean;
	findUserByApiKey?: (apiKey: string) => AuthUser | null;
	debug?: boolean;
};

/**
 * Creates an HTTP server that wraps the MCP server with API key auth
 * and role-based tool filtering. Uses Bun.serve() with the MCP SDK's
 * WebStandardStreamableHTTPServerTransport in stateless mode.
 */
export async function createMcpHttpServer(options: McpHttpServerOptions) {
	const { projectRoot, port, authEnabled, findUserByApiKey, debug } = options;

	// Create the base MCP server to get the registered tools
	const mcpServer = await createMcpServer(projectRoot, { debug });

	const server = Bun.serve({
		port,
		async fetch(req: Request): Promise<Response> {
			const url = new URL(req.url);

			if (url.pathname !== "/mcp") {
				return new Response("Not Found", { status: 404 });
			}

			// Auth check
			let userRole: "admin" | "viewer" | undefined;
			if (authEnabled) {
				const token = extractBearerToken(req.headers.get("Authorization"));
				if (!token || !findUserByApiKey) {
					return Response.json({ error: "Unauthorized" }, { status: 401 });
				}
				const user = findUserByApiKey(token);
				if (!user) {
					return Response.json({ error: "Unauthorized" }, { status: 401 });
				}
				userRole = user.role;
			}

			// Create a fresh stateless transport per request
			const transport = new WebStandardStreamableHTTPServerTransport({
				sessionIdGenerator: undefined, // stateless
			});

			// Create a per-request MCP Server with filtered tools
			const allTools = Array.from((mcpServer as any).tools?.values?.() ?? []);
			const filteredTools = filterToolsByRole(allTools, userRole);

			// Create a minimal Server instance for this request
			const perRequestServer = new Server(
				{ name: "backlog.md", version: "1.0.0" },
				{ capabilities: { tools: {} } },
			);

			// Register only the filtered tools
			for (const tool of filteredTools) {
				// Use the SDK's setRequestHandler pattern
			}

			// Connect and handle
			await perRequestServer.connect(transport);
			return transport.handleRequest(req);
		},
	});

	const url = `http://localhost:${server.port}`;
	if (debug) {
		console.error(`MCP HTTP server listening on ${url}`);
	}

	return {
		url,
		port: server.port,
		stop: async () => {
			server.stop(true);
			await mcpServer.stop();
		},
	};
}
```

**IMPORTANT NOTE:** The implementation above is a skeleton. The tricky part is creating per-request MCP Server instances with filtered tools. The actual approach should be:

1. Keep the full `McpServer` instance (with all tools registered)
2. Override `listTools()` and `callTool()` to filter based on the authenticated user's role
3. Pass the role through to the request handling

A cleaner approach: modify `McpServer` to accept a `role` parameter that filters `listTools()` and rejects unauthorized `callTool()`. Add a `setRequestRole(role)` method or pass it through the transport's auth info.

The implementer should read the `WebStandardStreamableHTTPServerTransport` source at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js` to understand how `authInfo` flows through to handlers. The transport passes `authInfo` to `onmessage`, which means the MCP SDK's `Server` class receives it. The implementer should check if `Server.setRequestHandler` callbacks receive auth info.

The key insight: `transport.handleRequest(req, { authInfo })` passes auth info that the Server makes available in handler callbacks. The implementer should verify this by checking the SDK's Server implementation.

**Step 4: Run tests to verify they pass**

Run: `CLAUDECODE=1 npx -y bun test src/mcp/http-transport.test.ts --timeout 30000`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/mcp/http-transport.ts src/mcp/http-transport.test.ts
git commit -m "Add MCP HTTP transport with auth and role-based tool filtering"
```

---

### Task 5: CLI Flags for HTTP Mode

**Files:**
- Modify: `src/commands/mcp.ts`

**Context:** Add `--http` and `--port` flags to `mcp start`. When `--http` is passed, use the HTTP transport. Otherwise, use stdio (current default).

**Step 1: Implement CLI flags**

Modify `src/commands/mcp.ts`:

```typescript
import type { Command } from "commander";
import { createMcpServer } from "../mcp/server.ts";
import { createMcpHttpServer } from "../mcp/http-transport.ts";
import { ConfigRepoService } from "../server/auth/config-repo.ts";

type StartOptions = {
	debug?: boolean;
	http?: boolean;
	port?: string;
};

function registerStartCommand(mcpCmd: Command): void {
	mcpCmd
		.command("start")
		.description("Start the MCP server")
		.option("-d, --debug", "Enable debug logging", false)
		.option("--http", "Use HTTP transport instead of stdio", false)
		.option("--port <number>", "Port for HTTP server (default: 3001)", "3001")
		.action(async (options: StartOptions) => {
			if (options.http) {
				await startHttpMode(options);
			} else {
				await startStdioMode(options);
			}
		});
}
```

The `startStdioMode` function is the existing code moved into a named function.

The `startHttpMode` function:
1. Reads `AUTH_CONFIG_REPO` from env
2. If set, creates `ConfigRepoService`, starts it, gets `findUserByApiKey`
3. Calls `createMcpHttpServer()` with auth options
4. Sets up signal handlers for graceful shutdown (cleanup config repo service + stop HTTP server)
5. Logs the listening URL

```typescript
async function startHttpMode(options: StartOptions): Promise<void> {
	const port = parseInt(options.port ?? "3001", 10);
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
	} else {
		if (options.debug) {
			console.error("Auth disabled (AUTH_CONFIG_REPO not set)");
		}
	}

	const { url, stop } = await createMcpHttpServer({
		projectRoot: process.cwd(),
		port,
		authEnabled,
		findUserByApiKey: authEnabled && configRepoService
			? (key: string) => configRepoService!.findUserByApiKey(key)
			: undefined,
		debug: options.debug,
	});

	console.error(`MCP HTTP server running at ${url}/mcp`);
	if (authEnabled) {
		console.error("Authentication: API key required (Bearer token)");
	} else {
		console.error("Authentication: disabled");
	}

	const shutdown = async () => {
		await stop();
		if (configRepoService) {
			await configRepoService.stop();
		}
		process.exit(0);
	};

	process.once("SIGINT", () => shutdown());
	process.once("SIGTERM", () => shutdown());
}
```

**Step 2: Verify TypeScript compiles**

Run: `npx -y bun x tsc --noEmit`
Expected: No errors

**Step 3: Commit**

```bash
git add src/commands/mcp.ts
git commit -m "Add --http and --port flags to mcp start command"
```

---

### Task 6: Integration Test and Final Verification

**Files:**
- Possibly modify: various files for lint fixes

**Step 1: Run full TypeScript check**

Run: `npx -y bun x tsc --noEmit`
Expected: No errors

**Step 2: Run Biome checks**

Run: `npx -y bun x @biomejs/biome check --write .`
Expected: Clean or auto-fixed

**Step 3: Run all auth tests**

Run: `CLAUDECODE=1 npx -y bun test src/server/auth/ src/mcp/auth/ --timeout 60000`
Expected: All pass

**Step 4: Run all MCP tests**

Run: `CLAUDECODE=1 npx -y bun test src/mcp/ --timeout 60000`
Expected: All pass (existing + new)

**Step 5: Run full test suite**

Run: `CLAUDECODE=1 npx -y bun test --timeout 180000`
Expected: All pass, exit code 0

**Step 6: Commit any lint fixes**

```bash
git add -A
git commit -m "Fix lint issues from MCP HTTP transport implementation"
```

---

## Important Notes for the Implementer

**bun is NOT in PATH on this machine.** Use:
- `npx -y bun` instead of `bun`
- `npx -y bun x` instead of `bunx`
- `npx -y bun test` instead of `bun test`

**The MCP SDK WebStandardStreamableHTTPServerTransport** lives at:
`@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js`

Read its source at `node_modules/@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js` to understand:
- How `handleRequest(req, { authInfo })` works
- How auth info flows to tool handlers via `onmessage`
- Stateless mode behavior (`sessionIdGenerator: undefined`)

**Tool filtering approach:** The cleanest way is to either:
- (A) Create a per-request `Server` instance with only the allowed tools registered, or
- (B) Modify `McpServer.listTools()` and `McpServer.callTool()` to accept a role and filter accordingly

Option (B) is more efficient (one Server instance) but requires careful thread-safety. Option (A) is simpler but creates more objects per request. Since this is stateless (one request = one transport), option (A) is simpler and recommended.

**Existing auth modules to reuse:**
- `src/server/auth/config-repo.ts` — `ConfigRepoService` (clone + poll)
- `src/server/auth/users-store.ts` — `UsersStore` (parse users.md)
- `src/server/auth/middleware.ts` — `extractBearerToken()` helper
