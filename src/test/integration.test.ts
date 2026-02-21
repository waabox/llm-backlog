/**
 * Integration tests: two git repos, black-box validation via HTTP endpoints and MCP.
 *
 * Config repo  – contains users.md (API keys, roles) — cloned by ConfigRepoService.
 * Project repo – contains the backlog with mock tasks, milestones, decisions, documents.
 *
 * Every test group starts the BacklogServer on a random port, exercises real HTTP
 * endpoints and the MCP protocol, and validates response payloads plus git state.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { BacklogServer } from "../server/index.ts";

// ── helpers ──────────────────────────────────────────────────────────────────

function uniqueDir(prefix: string): string {
	return join(process.cwd(), "tmp", `${prefix}-${randomUUID().slice(0, 8)}`);
}

async function cleanup(...dirs: string[]): Promise<void> {
	for (const dir of dirs) {
		try {
			await rm(dir, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}

async function initGitRepo(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true });
	await $`git init -b main ${dir}`.quiet();
	await $`git -C ${dir} config user.name "Tester"`.quiet();
	await $`git -C ${dir} config user.email "test@test.com"`.quiet();
}

async function gitCommitAll(dir: string, message: string): Promise<void> {
	await $`git -C ${dir} add -A`.quiet();
	await $`git -C ${dir} commit -m ${message} --allow-empty`.quiet();
}

async function gitLog(dir: string): Promise<string[]> {
	const result = await $`git -C ${dir} log --oneline`.quiet();
	return result.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim());
}

async function gitTrackedFiles(dir: string): Promise<string[]> {
	const result = await $`git -C ${dir} ls-files`.quiet();
	return result.stdout
		.toString()
		.split("\n")
		.filter((l) => l.trim());
}

// ── config repo fixture ───────────────────────────────────────────────────────

const ADMIN_API_KEY = "test-api-key-admin-001";
const VIEWER_API_KEY = "test-api-key-viewer-002";

async function buildConfigRepo(dir: string): Promise<void> {
	await initGitRepo(dir);
	const usersMd = `---
users:
  - email: admin@test.com
    name: Admin User
    role: admin
    apiKey: ${ADMIN_API_KEY}
  - email: viewer@test.com
    name: Viewer User
    role: viewer
    apiKey: ${VIEWER_API_KEY}
---

# Users

Managed by Backlog.md integration tests.
`;
	await writeFile(join(dir, "users.md"), usersMd);
	await gitCommitAll(dir, "initial: add users.md");
}

// ── project repo fixture ──────────────────────────────────────────────────────

const CONFIG_YML = `project_name: "Integration Test Project"
default_status: "To Do"
statuses:
  - "To Do"
  - "In Progress"
  - "Done"
labels:
  - bug
  - feature
auto_commit: true
zero_padded_ids: 0
task_prefix: task
`;

const TASK_1_MD = `---
id: task-1
title: Initial Task
status: To Do
assignee: []
reporter: '@admin'
created_date: '2026-01-01'
labels: []
dependencies: []
priority: medium
---

## Description

First task for integration testing.
`;

const TASK_2_MD = `---
id: task-2
title: Second Task
status: In Progress
assignee:
  - '@viewer'
reporter: '@admin'
created_date: '2026-01-02'
labels:
  - feature
dependencies:
  - task-1
priority: high
---

## Description

Second task, depends on task-1.
`;

const MILESTONE_MD = `---
id: m-0
title: "Release 1.0"
---

## Description

First release milestone.
`;

const DECISION_MD = `---
id: decision-1
title: Use TypeScript
date: '2026-01-01'
status: accepted
---

## Context

We need a typed language for the project.

## Decision

Use TypeScript 5 with strict mode.

## Consequences

Better type safety and IDE support.
`;

const DOC_MD = `---
id: doc-001
title: Getting Started Guide
type: guide
created_date: '2026-01-01'
tags: []
---

## Overview

This guide explains how to get started.
`;

async function buildProjectRepo(dir: string): Promise<void> {
	await initGitRepo(dir);

	const backlog = join(dir, "backlog");
	const paths = {
		tasks: join(backlog, "tasks"),
		completed: join(backlog, "completed"),
		archive: join(backlog, "archive", "tasks"),
		archiveDrafts: join(backlog, "archive", "drafts"),
		drafts: join(backlog, "drafts"),
		milestones: join(backlog, "milestones"),
		archiveMilestones: join(backlog, "archive", "milestones"),
		decisions: join(backlog, "decisions"),
		docs: join(backlog, "docs"),
	};

	for (const p of Object.values(paths)) {
		await mkdir(p, { recursive: true });
	}

	await writeFile(join(backlog, "config.yml"), CONFIG_YML);
	await mkdir(join(paths.tasks, "task-1"), { recursive: true });
	await writeFile(join(paths.tasks, "task-1", "task-1 - Initial Task.md"), TASK_1_MD);
	await mkdir(join(paths.tasks, "task-2"), { recursive: true });
	await writeFile(join(paths.tasks, "task-2", "task-2 - Second Task.md"), TASK_2_MD);
	await writeFile(join(paths.milestones, "m-0 - release-1.0.md"), MILESTONE_MD);
	await writeFile(join(paths.decisions, "decision-1 - Use TypeScript.md"), DECISION_MD);
	await writeFile(join(paths.docs, "doc-001 - Getting Started Guide.md"), DOC_MD);

	await gitCommitAll(dir, "initial: add mock backlog data");
}

// ── server lifecycle ──────────────────────────────────────────────────────────

/** Picks a random port between 14000 and 15000 to avoid conflicts. */
function randomPort(): number {
	return 14000 + Math.floor(Math.random() * 1000);
}

type TestEnv = {
	configDir: string;
	projectDir: string;
	server: BacklogServer;
	port: number;
	baseUrl: string;
	adminHeaders: HeadersInit;
	viewerHeaders: HeadersInit;
};

async function startTestEnv(): Promise<TestEnv> {
	const configDir = uniqueDir("cfg-repo");
	const projectDir = uniqueDir("proj-repo");

	await buildConfigRepo(configDir);
	await buildProjectRepo(projectDir);

	process.env.AUTH_CONFIG_REPO = configDir;
	// Ensure GOOGLE_CLIENT_ID is unset so auth mode is "MCP API key only",
	// which leaves REST endpoints unguarded by JWT and lets API keys through.
	delete process.env.GOOGLE_CLIENT_ID;

	const server = new BacklogServer(projectDir);
	const port = randomPort();
	await server.start(port, false);

	return {
		configDir,
		projectDir,
		server,
		port,
		baseUrl: `http://localhost:${port}`,
		adminHeaders: { Authorization: `Bearer ${ADMIN_API_KEY}`, "Content-Type": "application/json" },
		viewerHeaders: { Authorization: `Bearer ${VIEWER_API_KEY}`, "Content-Type": "application/json" },
	};
}

async function stopTestEnv(env: TestEnv): Promise<void> {
	await env.server.stop();
	delete process.env.AUTH_CONFIG_REPO;
	await cleanup(env.configDir, env.projectDir);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("REST API — tasks", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/tasks lists mock tasks", async () => {
		const res = await fetch(`${env.baseUrl}/api/tasks`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const body = await res.json();
		const tasks = Array.isArray(body) ? body : (body.tasks ?? body.data ?? []);
		expect(tasks.length).toBeGreaterThanOrEqual(2);
		// IDs are normalised to uppercase prefix by the server
		const titles = tasks.map((t: { title: string }) => t.title);
		expect(titles).toContain("Initial Task");
		expect(titles).toContain("Second Task");
	});

	test("GET /api/tasks/:id returns a specific task", async () => {
		// List first to get the real server-assigned ID
		const listRes = await fetch(`${env.baseUrl}/api/tasks`, { headers: env.adminHeaders });
		const body = await listRes.json();
		const tasks = Array.isArray(body) ? body : (body.tasks ?? body.data ?? []);
		const task1 = tasks.find((t: { title: string }) => t.title === "Initial Task");
		expect(task1).toBeTruthy();

		const res = await fetch(`${env.baseUrl}/api/tasks/${task1.id}`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const task = await res.json();
		expect(task.title).toBe("Initial Task");
		expect(task.status).toBe("To Do");
	});

	test("POST /api/tasks creates a new task and commits it", async () => {
		const logBefore = await gitLog(env.projectDir);

		const res = await fetch(`${env.baseUrl}/api/tasks`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Created via API", description: "Integration test creation" }),
		});
		expect([200, 201]).toContain(res.status);
		const task = await res.json();
		expect(task.title).toBe("Created via API");
		expect(task.id).toBeTruthy();

		// git state: a commit was created (auto_commit: true)
		const logAfter = await gitLog(env.projectDir);
		expect(logAfter.length).toBeGreaterThan(logBefore.length);

		// task file must be tracked in git
		const tracked = await gitTrackedFiles(env.projectDir);
		expect(tracked.some((f) => f.toLowerCase().includes(task.id.toLowerCase()))).toBe(true);
	});

	test("PUT /api/tasks/:id updates task status", async () => {
		// Get task-2's real ID from the list
		const listRes = await fetch(`${env.baseUrl}/api/tasks`, { headers: env.adminHeaders });
		const body = await listRes.json();
		const tasks = Array.isArray(body) ? body : (body.tasks ?? body.data ?? []);
		const task2 = tasks.find((t: { title: string }) => t.title === "Second Task");
		expect(task2).toBeTruthy();

		const res = await fetch(`${env.baseUrl}/api/tasks/${task2.id}`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify({ status: "Done" }),
		});
		expect(res.status).toBe(200);
		const updated = await res.json();
		expect(updated.status).toBe("Done");
	});

	test("POST /api/tasks/:id/complete moves task to completed", async () => {
		// Get real ID for Initial Task
		const listRes = await fetch(`${env.baseUrl}/api/tasks`, { headers: env.adminHeaders });
		const body = await listRes.json();
		const tasks = Array.isArray(body) ? body : (body.tasks ?? body.data ?? []);
		const task1 = tasks.find((t: { title: string }) => t.title === "Initial Task");
		expect(task1).toBeTruthy();

		const res = await fetch(`${env.baseUrl}/api/tasks/${task1.id}/complete`, {
			method: "POST",
			headers: env.adminHeaders,
		});
		expect(res.status).toBe(200);

		// task-1 should no longer appear in the active list
		const listRes2 = await fetch(`${env.baseUrl}/api/tasks`, { headers: env.adminHeaders });
		const body2 = await listRes2.json();
		const activeTasks = Array.isArray(body2) ? body2 : (body2.tasks ?? body2.data ?? []);
		const activeTitles = activeTasks.map((t: { title: string }) => t.title);
		expect(activeTitles).not.toContain("Initial Task");

		// file must exist under completed/ in git
		const tracked = await gitTrackedFiles(env.projectDir);
		expect(tracked.some((f) => f.includes("completed") && f.toLowerCase().includes(task1.id.toLowerCase()))).toBe(true);
	});
});

describe("REST API — milestones", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/milestones returns mock milestone", async () => {
		const res = await fetch(`${env.baseUrl}/api/milestones`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const milestones = await res.json();
		expect(Array.isArray(milestones)).toBe(true);
		expect(milestones.length).toBeGreaterThanOrEqual(1);
		expect(milestones[0].id).toBe("m-0");
		expect(milestones[0].title).toBe("Release 1.0");
	});

	test("POST /api/milestones creates a milestone and persists the file", async () => {
		const res = await fetch(`${env.baseUrl}/api/milestones`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Release 2.0", description: "Second major release" }),
		});
		expect([200, 201]).toContain(res.status);
		const milestone = await res.json();
		expect(milestone.title).toBe("Release 2.0");
		expect(milestone.id).toMatch(/^m-\d+$/);

		// Verify via GET that the milestone is now listed
		const listRes = await fetch(`${env.baseUrl}/api/milestones`, { headers: env.adminHeaders });
		const milestones = await listRes.json();
		expect(milestones.some((m: { title: string }) => m.title === "Release 2.0")).toBe(true);
	});

	test("GET /api/milestones/:id returns a specific milestone", async () => {
		const res = await fetch(`${env.baseUrl}/api/milestones/m-0`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const milestone = await res.json();
		expect(milestone.id).toBe("m-0");
	});

	test("PUT /api/milestones/:id/active toggles milestone active state", async () => {
		// Create a new milestone — defaults to active: false
		const createRes = await fetch(`${env.baseUrl}/api/milestones`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Backlog General" }),
		});
		expect([200, 201]).toContain(createRes.status);
		const created = await createRes.json();
		const milestoneId = created.id;
		expect(milestoneId).toMatch(/^m-\d+$/);

		// Verify it defaults to inactive
		const listRes = await fetch(`${env.baseUrl}/api/milestones`, { headers: env.adminHeaders });
		const milestones = await listRes.json();
		const newMilestone = milestones.find((m: { id: string }) => m.id === milestoneId);
		expect(newMilestone).toBeDefined();
		expect(newMilestone.active).toBe(false);

		// Activate the milestone
		const activateRes = await fetch(`${env.baseUrl}/api/milestones/${milestoneId}/active`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify({ active: true }),
		});
		expect(activateRes.status).toBe(200);
		const activated = await activateRes.json();
		expect(activated.success).toBe(true);
		expect(activated.milestone.active).toBe(true);

		// Verify via GET that it's now active
		const afterActivateRes = await fetch(`${env.baseUrl}/api/milestones`, { headers: env.adminHeaders });
		const afterActivate = await afterActivateRes.json();
		const activatedMilestone = afterActivate.find((m: { id: string }) => m.id === milestoneId);
		expect(activatedMilestone.active).toBe(true);

		// Deactivate the milestone
		const deactivateRes = await fetch(`${env.baseUrl}/api/milestones/${milestoneId}/active`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify({ active: false }),
		});
		expect(deactivateRes.status).toBe(200);
		const deactivated = await deactivateRes.json();
		expect(deactivated.success).toBe(true);
		expect(deactivated.milestone.active).toBe(false);
	});
});

describe("REST API — decisions & docs", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/decisions returns mock decision", async () => {
		const res = await fetch(`${env.baseUrl}/api/decisions`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const decisions = await res.json();
		expect(Array.isArray(decisions)).toBe(true);
		expect(decisions.some((d: { id: string }) => d.id === "decision-1")).toBe(true);
	});

	test("POST /api/decisions creates a decision", async () => {
		// API only takes { title } — body/content is updated via PUT
		const res = await fetch(`${env.baseUrl}/api/decisions`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Use Bun as runtime" }),
		});
		expect([200, 201]).toContain(res.status);
		const decision = await res.json();
		expect(decision.title).toBe("Use Bun as runtime");
	});

	test("GET /api/docs returns mock document", async () => {
		const res = await fetch(`${env.baseUrl}/api/docs`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const docs = await res.json();
		expect(Array.isArray(docs)).toBe(true);
		expect(docs.some((d: { id: string }) => d.id === "doc-001")).toBe(true);
	});

	test("POST /api/docs creates a document", async () => {
		// API expects { filename, content } — filename becomes the title
		const res = await fetch(`${env.baseUrl}/api/docs`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ filename: "Deployment Guide.md", content: "## Steps\n\nDeploy here." }),
		});
		expect([200, 201]).toContain(res.status);
		const doc = await res.json();
		expect(doc.id ?? doc.success).toBeTruthy();
	});
});

describe("REST API — config & status", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/status returns project info", async () => {
		const res = await fetch(`${env.baseUrl}/api/status`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const status = await res.json();
		expect(status).toBeTruthy();
	});

	test("GET /api/config returns project config", async () => {
		const res = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const config = await res.json();
		expect(config.projectName ?? config.project_name).toBe("Integration Test Project");
	});

	test("GET /api/statuses returns configured statuses", async () => {
		const res = await fetch(`${env.baseUrl}/api/statuses`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const statuses = await res.json();
		expect(Array.isArray(statuses)).toBe(true);
		expect(statuses).toContain("To Do");
		expect(statuses).toContain("Done");
	});
});

describe("REST API — asset endpoints", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/tasks/:id/assets returns empty array when no assets exist", async () => {
		const res = await fetch(`${env.baseUrl}/api/tasks/task-1/assets`, {
			headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
		});
		expect(res.status).toBe(200);
		const assets = await res.json();
		expect(Array.isArray(assets)).toBe(true);
		expect(assets.length).toBe(0);
	});

	test("POST /api/tasks/:id/assets uploads a file and it appears in list with correct metadata", async () => {
		const form = new FormData();
		form.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

		const uploadRes = await fetch(`${env.baseUrl}/api/tasks/task-1/assets`, {
			method: "POST",
			headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
			body: form,
		});
		expect(uploadRes.status).toBe(201);
		const metadata = await uploadRes.json();

		expect(metadata.filename).toMatch(/^\d+-test\.txt$/);
		expect(metadata.originalName).toBe("test.txt");
		expect(metadata.mimeType).toBe("text/plain");
		expect(metadata.size).toBe(11);
		expect(metadata.url).toMatch(/^\/assets\/000\/task-1\//);
		expect(metadata.isImage).toBe(false);

		const listRes = await fetch(`${env.baseUrl}/api/tasks/task-1/assets`, {
			headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
		});
		expect(listRes.status).toBe(200);
		const assets = await listRes.json();
		expect(Array.isArray(assets)).toBe(true);
		const uploaded = assets.find((a: { filename: string }) => a.filename === metadata.filename);
		expect(uploaded).toBeTruthy();
		expect(uploaded.originalName).toBe("test.txt");
	});

	test("DELETE /api/tasks/:id/assets/:filename removes the file from the list", async () => {
		const form = new FormData();
		form.append("file", new File(["delete me"], "todelete.txt", { type: "text/plain" }));

		const uploadRes = await fetch(`${env.baseUrl}/api/tasks/task-2/assets`, {
			method: "POST",
			headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
			body: form,
		});
		expect(uploadRes.status).toBe(201);
		const metadata = await uploadRes.json();

		const deleteRes = await fetch(`${env.baseUrl}/api/tasks/task-2/assets/${encodeURIComponent(metadata.filename)}`, {
			method: "DELETE",
			headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
		});
		expect(deleteRes.status).toBe(200);
		const deleteBody = await deleteRes.json();
		expect(deleteBody.success).toBe(true);

		const listRes = await fetch(`${env.baseUrl}/api/tasks/task-2/assets`, {
			headers: { Authorization: `Bearer ${ADMIN_API_KEY}` },
		});
		expect(listRes.status).toBe(200);
		const assets = await listRes.json();
		const found = assets.find((a: { filename: string }) => a.filename === metadata.filename);
		expect(found).toBeUndefined();
	});
});

describe("MCP endpoint", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	async function mcpCall(env: TestEnv, body: unknown): Promise<Response> {
		return fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: {
				...env.adminHeaders,
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
		});
	}

	test("tools/list returns available tools", async () => {
		const res = await mcpCall(env, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {},
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body).toContain("tools");
	});

	test("tools/call task_list returns tasks", async () => {
		const res = await mcpCall(env, {
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: {
				name: "task_list",
				arguments: {},
			},
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		// Response is SSE or JSON — either way it should contain task content
		expect(body.toLowerCase()).toMatch(/task|initial/);
	});

	test("tools/call task_create creates a task via MCP", async () => {
		const logBefore = await gitLog(env.projectDir);

		const res = await mcpCall(env, {
			jsonrpc: "2.0",
			id: 3,
			method: "tools/call",
			params: {
				name: "task_create",
				arguments: { title: "MCP Created Task", description: "Created via MCP protocol" },
			},
		});
		expect(res.status).toBe(200);
		const body = await res.text();
		expect(body.toLowerCase()).toContain("mcp created task");

		const logAfter = await gitLog(env.projectDir);
		expect(logAfter.length).toBeGreaterThan(logBefore.length);
	});

	test("resources/list returns available resources", async () => {
		const res = await mcpCall(env, {
			jsonrpc: "2.0",
			id: 4,
			method: "resources/list",
			params: {},
		});
		expect(res.status).toBe(200);
	});

	test("unauthenticated MCP request is rejected", async () => {
		const res = await fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} }),
		});
		expect(res.status).toBe(401);
	});
});

describe("MCP ↔ REST sync", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	async function mcpCall(body: unknown): Promise<Response> {
		return fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: {
				...env.adminHeaders,
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
		});
	}

	test("task created via MCP is immediately visible via REST", async () => {
		// Create via MCP
		await mcpCall({
			jsonrpc: "2.0",
			id: 10,
			method: "tools/call",
			params: {
				name: "task_create",
				arguments: { title: "Sync test from MCP" },
			},
		});

		// List via REST — no delay needed because patch chain is synchronous
		const res = await fetch(`${env.baseUrl}/api/tasks`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const body = await res.json();
		const tasks = Array.isArray(body) ? body : (body.tasks ?? body.data ?? []);
		const titles = tasks.map((t: { title: string }) => t.title);
		expect(titles).toContain("Sync test from MCP");
	});

	test("task created via REST is immediately visible via MCP task_list", async () => {
		// Create via REST
		await fetch(`${env.baseUrl}/api/tasks`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Sync test from REST" }),
		});

		// List via MCP
		const res = await mcpCall({
			jsonrpc: "2.0",
			id: 11,
			method: "tools/call",
			params: { name: "task_list", arguments: {} },
		});
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("Sync test from REST");
	});
});

describe("MCP — task_move", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	async function mcpMove(id: string, status: string): Promise<Response> {
		return fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: {
				...env.adminHeaders,
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "task_move", arguments: { id, status } },
			}),
		});
	}

	test("task_move auto-assigns unassigned task to caller and sets status to In Progress", async () => {
		// task-1 has no assignee; admin requests status "Done" but should be forced to "In Progress"
		const res = await mcpMove("task-1", "Done");
		expect(res.status).toBe(200);
		const viewRes = await fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: { ...env.adminHeaders, Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "task_view", arguments: { id: "task-1" } },
			}),
		});
		const viewBody = await viewRes.text();
		expect(viewBody).toContain("Admin User");
		expect(viewBody.toLowerCase()).toContain("in progress");
	});

	test("task_move sets requested status when caller is already the assignee", async () => {
		// task-1 is now assigned to Admin User from previous test
		const res = await mcpMove("task-1", "Done");
		expect(res.status).toBe(200);
		const viewRes = await fetch(`${env.baseUrl}/mcp`, {
			method: "POST",
			headers: { ...env.adminHeaders, Accept: "application/json, text/event-stream" },
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 2,
				method: "tools/call",
				params: { name: "task_view", arguments: { id: "task-1" } },
			}),
		});
		const viewBody = await viewRes.text();
		expect(viewBody.toLowerCase()).toContain("done");
	});
});

describe("REST API — config", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/config returns full config", async () => {
		const res = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const config = await res.json();
		expect(config.projectName).toBe("Integration Test Project");
		expect(Array.isArray(config.labels)).toBe(true);
		expect(Array.isArray(config.statuses)).toBe(true);
	});

	test("PUT /api/config updates labels and commits", async () => {
		const current = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders }).then((r) => r.json());
		const logBefore = await gitLog(env.projectDir);

		const updated = { ...current, labels: ["bug", "feature", "enhancement"] };
		const res = await fetch(`${env.baseUrl}/api/config`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify(updated),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.labels).toEqual(["bug", "feature", "enhancement"]);

		// Verify config was persisted
		const refetched = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders }).then((r) => r.json());
		expect(refetched.labels).toEqual(["bug", "feature", "enhancement"]);

		// Verify a new commit was created
		const logAfter = await gitLog(env.projectDir);
		expect(logAfter.length).toBeGreaterThan(logBefore.length);
		expect(logAfter[0]).toContain("update project configuration");
	});

	test("PUT /api/config updates statuses", async () => {
		const current = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders }).then((r) => r.json());

		const updated = { ...current, statuses: ["Backlog", "In Progress", "Review", "Done"] };
		const res = await fetch(`${env.baseUrl}/api/config`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify(updated),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.statuses).toEqual(["Backlog", "In Progress", "Review", "Done"]);
	});
});

// ── subtask bidirectional navigation ─────────────────────────────────────────

async function mcpToolCall(
	env: TestEnv,
	toolName: string,
	args: Record<string, unknown>,
): Promise<{ result: { content: Array<{ text: string }> } }> {
	const res = await fetch(`${env.baseUrl}/mcp`, {
		method: "POST",
		headers: {
			...env.adminHeaders,
			Accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: Math.floor(Math.random() * 10000),
			method: "tools/call",
			params: { name: toolName, arguments: args },
		}),
	});

	const text = await res.text();

	// The MCP endpoint may return SSE (text/event-stream) or plain JSON.
	// Extract the JSON-RPC result from either format.
	let parsed: { result?: { content: Array<{ text: string }> } };
	const jsonLine = text
		.split("\n")
		.map((l) => l.replace(/^data:\s*/, "").trim())
		.find((l) => l.startsWith("{"));
	if (jsonLine) {
		parsed = JSON.parse(jsonLine);
	} else {
		parsed = JSON.parse(text);
	}

	return parsed as { result: { content: Array<{ text: string }> } };
}

describe("subtask bidirectional navigation", () => {
	let env: TestEnv;
	beforeAll(async () => {
		env = await startTestEnv();
	});
	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("parent task file lists subtask ID in subtasks frontmatter after subtask creation", async () => {
		// Create parent task
		const parentRes = await mcpToolCall(env, "task_create", { title: "Parent Task" });
		const parentText: string = parentRes.result.content[0]?.text ?? "";
		const parentIdMatch = parentText.match(/task-\d+/i);
		expect(parentIdMatch).not.toBeNull();
		const parentId = (parentIdMatch as RegExpMatchArray)[0];

		// Create subtask with parentTaskId
		const subRes = await mcpToolCall(env, "task_create", { title: "Child Task", parentTaskId: parentId });
		const subText: string = subRes.result.content[0]?.text ?? "";
		const subIdMatch = subText.match(new RegExp(`${parentId}\\.\\d+`, "i"));
		expect(subIdMatch).not.toBeNull();
		const subId = (subIdMatch as RegExpMatchArray)[0].toLowerCase();

		// Read the parent task file from disk and verify the subtasks frontmatter array contains the subtask ID.
		// This validates bidirectional navigation at the file level, not just the dynamic view-time lookup.
		const parentTaskDir = join(env.projectDir, "backlog", "tasks", parentId);
		const files = await Array.fromAsync(new Bun.Glob("*.md").scan({ cwd: parentTaskDir }));
		expect(files).toHaveLength(1);
		const parentFilePath = join(parentTaskDir, files[0] as string);
		const parentFileContent = await Bun.file(parentFilePath).text();
		expect(parentFileContent.toLowerCase()).toContain(subId);
	});
});

// ── SQLite coordination layer ─────────────────────────────────────────────────

describe("SQLite coordination layer", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("backlog_sync tool responds with 200 and a sync message", async () => {
		const body = await mcpToolCall(env, "backlog_sync", {});
		const text = body.result.content[0]?.text ?? "";
		expect(text).toContain("Sync complete");
		expect(text).toContain("Tasks:");
	});

	test("sequential task creates produce unique IDs", async () => {
		const ids: string[] = [];
		for (let i = 0; i < 5; i++) {
			const body = await mcpToolCall(env, "task_create", {
				title: `SQLite coordination task ${i}`,
				status: "todo",
			});
			const text = body.result.content[0]?.text ?? "";
			const match = text.match(/[A-Z]+-\d+/);
			if (match) ids.push(match[0]);
		}
		const unique = new Set(ids);
		expect(ids.length).toBe(5);
		expect(unique.size).toBe(ids.length);
	});

	test("task_list returns a non-empty task listing", async () => {
		const body = await mcpToolCall(env, "task_list", {});
		const text = body.result.content[0]?.text ?? "";
		expect(text.length).toBeGreaterThan(0);
	});
});

// ── Milestone cascade to subtasks ────────────────────────────────────────────

describe("milestone cascade to subtasks", () => {
	let env: TestEnv;
	beforeAll(async () => {
		env = await startTestEnv();
	});
	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("updating a task's milestone cascades to its subtasks", async () => {
		// Create two milestones
		const m1Res = await fetch(`${env.baseUrl}/api/milestones`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Sprint Alpha" }),
		});
		expect(m1Res.status).toBe(201);
		const m1 = await m1Res.json();

		const m2Res = await fetch(`${env.baseUrl}/api/milestones`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Sprint Beta" }),
		});
		expect(m2Res.status).toBe(201);
		const m2 = await m2Res.json();

		// Create parent task with milestone Sprint Alpha
		const parentRes = await fetch(`${env.baseUrl}/api/tasks`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Parent Task", milestone: m1.id }),
		});
		expect(parentRes.status).toBe(201);
		const parent = await parentRes.json();

		// Create subtask under parent with same milestone
		const subtaskRes = await fetch(`${env.baseUrl}/api/tasks`, {
			method: "POST",
			headers: env.adminHeaders,
			body: JSON.stringify({ title: "Subtask One", parentTaskId: parent.id, milestone: m1.id }),
		});
		expect(subtaskRes.status).toBe(201);
		const subtask = await subtaskRes.json();

		// Move parent to Sprint Beta
		const updateRes = await fetch(`${env.baseUrl}/api/tasks/${parent.id}`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify({ milestone: m2.id }),
		});
		expect(updateRes.status).toBe(200);

		// Verify subtask was moved to Sprint Beta as well
		const subtaskAfterRes = await fetch(`${env.baseUrl}/api/tasks/${subtask.id}`, {
			headers: env.adminHeaders,
		});
		expect(subtaskAfterRes.status).toBe(200);
		const subtaskAfter = await subtaskAfterRes.json();
		expect(subtaskAfter.milestone).toBe(m2.id);
	});
});
