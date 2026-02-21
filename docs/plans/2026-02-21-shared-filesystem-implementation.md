# Shared FileSystem and GitOperations Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Share a single `FileSystem` and `GitOperations` instance between the Web (`BacklogServer.core`) and the embedded MCP server, so that both `ContentStore`s always stay in sync via the existing patch-chain mechanism.

**Architecture:** `Core`'s constructor is extended to accept pre-built `FileSystem` and `GitOperations` instances. `BacklogServer` creates them once and passes them to both `Core` (web) and `createMcpRequestHandler` (MCP). `ContentStore.patchFilesystem()` already chains patches on the shared `FileSystem`, so both caches update on any write. The `backlogWatcher` workaround is deleted.

**Tech Stack:** Bun, TypeScript 5, existing `FileSystem` / `GitOperations` / `Core` / `ContentStore` classes.

---

### Task 1: Extend `Core` constructor to accept injected infrastructure

**Files:**
- Modify: `src/core/backlog.ts:110-117`

**Step 1: Add imports for FileSystem and GitOperations (they're already used — verify they're imported)**

Open `src/core/backlog.ts`. The file already imports `FileSystem` from `"../file-system/operations.ts"` and `GitOperations` from `"../git/operations.ts"`. Nothing to add.

**Step 2: Change the constructor signature and body**

Find this block (around line 110):
```typescript
constructor(projectRoot: string, options?: { enableWatchers?: boolean }) {
    this.fs = new FileSystem(projectRoot);
    this.git = new GitOperations(projectRoot);
    this.enableWatchers = options?.enableWatchers ?? false;
```

Replace with:
```typescript
constructor(
    projectRoot: string,
    options?: {
        enableWatchers?: boolean;
        filesystem?: FileSystem;
        gitOperations?: GitOperations;
    },
) {
    this.fs = options?.filesystem ?? new FileSystem(projectRoot);
    this.git = options?.gitOperations ?? new GitOperations(projectRoot);
    this.enableWatchers = options?.enableWatchers ?? false;
```

**Step 3: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/core/backlog.ts
git commit -m "feat: allow Core to accept injected FileSystem and GitOperations"
```

---

### Task 2: Extend `McpServer` and `createMcpServer` to forward shared instances

**Files:**
- Modify: `src/mcp/server.ts:48-53` (ServerInitOptions type)
- Modify: `src/mcp/server.ts:61-80` (McpServer constructor)
- Modify: `src/mcp/server.ts:297-330` (createMcpServer factory)

**Step 1: Check existing imports in `src/mcp/server.ts`**

The file imports `Core` from `"../core/backlog.ts"`. `FileSystem` and `GitOperations` are not imported. Add them at the top of the imports block:

```typescript
import { FileSystem } from "../file-system/operations.ts";
import { GitOperations } from "../git/operations.ts";
```

**Step 2: Extend `ServerInitOptions`**

Find:
```typescript
type ServerInitOptions = {
    debug?: boolean;
};
```

Replace with:
```typescript
type ServerInitOptions = {
    debug?: boolean;
    filesystem?: FileSystem;
    gitOperations?: GitOperations;
};
```

**Step 3: Extend `McpServer` constructor**

Find:
```typescript
constructor(projectRoot: string, instructions: string) {
    super(projectRoot, { enableWatchers: true });
```

Replace with:
```typescript
constructor(
    projectRoot: string,
    instructions: string,
    options?: { filesystem?: FileSystem; gitOperations?: GitOperations },
) {
    super(projectRoot, { enableWatchers: true, filesystem: options?.filesystem, gitOperations: options?.gitOperations });
```

**Step 4: Update `createMcpServer` to forward shared instances**

In `createMcpServer`, find the two places where `Core` and `McpServer` are instantiated:

```typescript
const tempCore = new Core(projectRoot);
```
Replace with:
```typescript
const tempCore = new Core(projectRoot, { filesystem: options.filesystem, gitOperations: options.gitOperations });
```

And find:
```typescript
const server = new McpServer(projectRoot, instructions);
```
Replace with:
```typescript
const server = new McpServer(projectRoot, instructions, { filesystem: options.filesystem, gitOperations: options.gitOperations });
```

**Step 5: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 6: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: forward shared FileSystem and GitOperations through McpServer"
```

---

### Task 3: Extend `createMcpRequestHandler` to accept and use shared instances

**Files:**
- Modify: `src/mcp/http-transport.ts:35-41` (McpRequestHandlerOptions type)
- Modify: `src/mcp/http-transport.ts:65-72` (createMcpRequestHandler body)

**Step 1: Add imports**

`src/mcp/http-transport.ts` does not import `FileSystem` or `GitOperations`. Add:
```typescript
import { FileSystem } from "../file-system/operations.ts";
import { GitOperations } from "../git/operations.ts";
```

**Step 2: Extend `McpRequestHandlerOptions`**

Find:
```typescript
export type McpRequestHandlerOptions = {
    projectRoot: string;
    authEnabled: boolean;
    findUserByApiKey?: (apiKey: string) => AuthUser | null;
    debug?: boolean;
    autoPush?: boolean;
};
```

Replace with:
```typescript
export type McpRequestHandlerOptions = {
    projectRoot: string;
    authEnabled: boolean;
    findUserByApiKey?: (apiKey: string) => AuthUser | null;
    debug?: boolean;
    autoPush?: boolean;
    filesystem?: FileSystem;
    gitOperations?: GitOperations;
};
```

**Step 3: Pass shared instances to `createMcpServer` and eagerly init ContentStore**

Find the start of `createMcpRequestHandler`:
```typescript
export async function createMcpRequestHandler(options: McpRequestHandlerOptions): Promise<McpRequestHandler> {
    const { projectRoot, authEnabled, findUserByApiKey, debug, autoPush } = options;

    const mcpServer = await createMcpServer(projectRoot, { debug });
```

Replace with:
```typescript
export async function createMcpRequestHandler(options: McpRequestHandlerOptions): Promise<McpRequestHandler> {
    const { projectRoot, authEnabled, findUserByApiKey, debug, autoPush, filesystem, gitOperations } = options;

    const mcpServer = await createMcpServer(projectRoot, { debug, filesystem, gitOperations });
    // Eagerly initialize ContentStore so the patch chain with the Web's ContentStore
    // is established before the first MCP request arrives.
    await mcpServer.getContentStore();
```

**Step 4: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 5: Commit**

```bash
git add src/mcp/http-transport.ts
git commit -m "feat: accept and forward shared FileSystem and GitOperations in MCP handler"
```

---

### Task 4: Write failing integration test for MCP ↔ REST sync

**Files:**
- Modify: `src/test/integration.test.ts` (add new `describe` block after the "MCP endpoint" block)

**Step 1: Add the test block**

Find the closing `});` of the `describe("MCP endpoint", ...)` block (around line 676) and add this block after it:

```typescript
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
```

**Step 2: Run the new tests to verify they fail**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts 2>&1 | grep -A 5 "MCP.*REST sync"
```
Expected: both tests FAIL (the patch chain isn't set up yet because `BacklogServer` still creates two separate `FileSystem` instances).

**Step 3: Commit the failing tests**

```bash
git add src/test/integration.test.ts
git commit -m "test: add failing sync tests for MCP to REST and REST to MCP"
```

---

### Task 5: Update `BacklogServer` to create and share `FileSystem` and `GitOperations`

**Files:**
- Modify: `src/server/index.ts`

**Step 1: Add imports**

In `src/server/index.ts`, add after the existing `Core` import:
```typescript
import { FileSystem } from "../file-system/operations.ts";
import { GitOperations } from "../git/operations.ts";
```

**Step 2: Add private fields for the shared instances**

Find the existing private field declarations block (around line 56-70). Add two new fields:
```typescript
private sharedFs: FileSystem | null = null;
private sharedGit: GitOperations | null = null;
```

Also remove this field (it's no longer needed):
```typescript
private backlogWatcher: { stop: () => void } | null = null;
```

**Step 3: Update constructor to create shared instances in local mode**

Find the constructor body:
```typescript
constructor(projectPath: string) {
    this.projectRepoUrl = process.env.BACKLOG_PROJECT_REPO ?? null;
    if (!this.projectRepoUrl) {
        this.core = new Core(projectPath, { enableWatchers: true });
    } else {
        // Core will be initialized in start() after the repo is cloned
        this.core = null as unknown as Core;
    }
}
```

Replace with:
```typescript
constructor(projectPath: string) {
    this.projectRepoUrl = process.env.BACKLOG_PROJECT_REPO ?? null;
    if (!this.projectRepoUrl) {
        this.sharedFs = new FileSystem(projectPath);
        this.sharedGit = new GitOperations(projectPath);
        this.core = new Core(projectPath, {
            enableWatchers: true,
            filesystem: this.sharedFs,
            gitOperations: this.sharedGit,
        });
    } else {
        // Core will be initialized in start() after the repo is cloned
        this.core = null as unknown as Core;
    }
}
```

**Step 4: Update `start()` to create shared instances in remote mode**

Find inside `start()`:
```typescript
if (this.projectRepoUrl) {
    console.log(`Cloning project repo: ${this.projectRepoUrl}`);
    this.projectRepoService = new ProjectRepoService(this.projectRepoUrl);
    await this.projectRepoService.start();
    this.core = new Core(this.projectRepoService.dir, { enableWatchers: true });
    this.core.git.setAutoPush(true);
    this.core.setAutoCommitOverride(true);
}
```

Replace with:
```typescript
if (this.projectRepoUrl) {
    console.log(`Cloning project repo: ${this.projectRepoUrl}`);
    this.projectRepoService = new ProjectRepoService(this.projectRepoUrl);
    await this.projectRepoService.start();
    this.sharedFs = new FileSystem(this.projectRepoService.dir);
    this.sharedGit = new GitOperations(this.projectRepoService.dir);
    this.core = new Core(this.projectRepoService.dir, {
        enableWatchers: true,
        filesystem: this.sharedFs,
        gitOperations: this.sharedGit,
    });
    this.sharedGit.setAutoPush(true);
    this.core.setAutoCommitOverride(true);
}
```

**Step 5: Remove the `backlogWatcher` setup block**

Find and delete this block entirely (around line 182-186 in `start()`):
```typescript
// When running with a remote repo the MCP handler uses its own Core instance,
// so task mutations bypass this.core's ContentStore. Watch the backlog directory
// on disk to detect those changes and notify the UI via WebSocket.
if (this.projectRepoUrl) {
    this.backlogWatcher = watchBacklogDir(this.core, () => {
        this.broadcastTasksUpdated();
    });
}
```

**Step 6: Pass shared instances to `createMcpRequestHandler`**

Find:
```typescript
this.mcpHandler = await createMcpRequestHandler({
    projectRoot: this.core.filesystem.rootDir,
    authEnabled: mcpAuthEnabled,
    findUserByApiKey: mcpAuthEnabled
        ? (key: string) => this.configRepoService?.findUserByApiKey(key) ?? null
        : undefined,
    autoPush: !!this.projectRepoUrl,
});
```

Replace with:
```typescript
this.mcpHandler = await createMcpRequestHandler({
    projectRoot: this.core.filesystem.rootDir,
    authEnabled: mcpAuthEnabled,
    findUserByApiKey: mcpAuthEnabled
        ? (key: string) => this.configRepoService?.findUserByApiKey(key) ?? null
        : undefined,
    autoPush: !!this.projectRepoUrl,
    filesystem: this.sharedFs ?? undefined,
    gitOperations: this.sharedGit ?? undefined,
});
```

**Step 7: Remove the `backlogWatcher` cleanup from `stop()`**

Find and delete this block entirely in `stop()`:
```typescript
// Stop backlog directory watcher
try {
    this.backlogWatcher?.stop();
    this.backlogWatcher = null;
} catch {}
```

**Step 8: Check if `watchBacklogDir` import is now unused**

At the top of `src/server/index.ts`, find:
```typescript
import { watchBacklogDir, watchConfig } from "../utils/config-watcher.ts";
```

If `watchBacklogDir` is no longer referenced anywhere in the file, remove it from the import:
```typescript
import { watchConfig } from "../utils/config-watcher.ts";
```

**Step 9: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 10: Run the sync tests to verify they now pass**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts 2>&1 | grep -A 5 "MCP.*REST sync"
```
Expected: both `MCP ↔ REST sync` tests PASS.

**Step 11: Run full test suite**

```bash
CLAUDECODE=1 bun test
```
Expected: all existing tests still pass.

**Step 12: Commit**

```bash
git add src/server/index.ts
git commit -m "feat: share FileSystem and GitOperations between Web and MCP, remove backlogWatcher"
```

---

### Task 6: Run linter and final verification

**Step 1: Biome check**

```bash
bun run check .
```
Expected: no lint or format errors. Fix any reported issues before proceeding.

**Step 2: Full test suite**

```bash
CLAUDECODE=1 bun test
```
Expected: all tests pass.

**Step 3: Build**

```bash
bun run build
```
Expected: build completes without errors.

**Step 4: Commit any lint fixes (if needed)**

```bash
git add -p
git commit -m "style: fix lint issues after shared infrastructure refactor"
```
