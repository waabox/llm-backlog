import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthUser } from "../server/auth/users-store.ts";
import { createMcpHttpServer } from "./http-transport.ts";

const TEST_DIR_PREFIX = join(tmpdir(), "backlog-mcp-http-test-");

describe("MCP HTTP Transport", () => {
	let testDir: string;
	let stopServer: (() => Promise<void>) | null = null;

	beforeEach(async () => {
		testDir = await mkdtemp(TEST_DIR_PREFIX);
		await mkdir(join(testDir, "backlog"), { recursive: true });
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

		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
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
		expect(response.status).toBe(200);
	});

	it("returns 404 for non-mcp paths", async () => {
		const { url, stop } = await createMcpHttpServer({
			projectRoot: testDir,
			port: 0,
			authEnabled: false,
		});
		stopServer = stop;

		const response = await fetch(`${url}/other`);
		expect(response.status).toBe(404);
	});

	it("authenticates valid API key and serves MCP requests", async () => {
		const adminUser: AuthUser = {
			email: "admin@test.com",
			name: "Admin",
			role: "admin",
			apiKey: "bkmd_valid_key",
		};
		const findUser = (key: string): AuthUser | null => (key === "bkmd_valid_key" ? adminUser : null);

		const { url, stop } = await createMcpHttpServer({
			projectRoot: testDir,
			port: 0,
			authEnabled: true,
			findUserByApiKey: findUser,
		});
		stopServer = stop;

		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				Authorization: "Bearer bkmd_valid_key",
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
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
		expect(response.status).toBe(200);
	});

	it("returns 401 when auth is enabled but no findUserByApiKey provided", async () => {
		const { url, stop } = await createMcpHttpServer({
			projectRoot: testDir,
			port: 0,
			authEnabled: true,
		});
		stopServer = stop;

		const response = await fetch(`${url}/mcp`, {
			method: "POST",
			headers: {
				Authorization: "Bearer bkmd_some_key",
				"Content-Type": "application/json",
			},
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
		expect(response.status).toBe(401);
	});
});
