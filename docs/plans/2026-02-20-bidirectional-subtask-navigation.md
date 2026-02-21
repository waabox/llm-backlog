# Bidirectional Subtask Navigation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a subtask is created, the parent task's markdown file is updated to list that subtask in its `subtasks` frontmatter field, enabling bidirectional navigation (child knows its parent via `parent_task_id`; parent knows its children via `subtasks`).

**Architecture:** The fix lives in `createTask` (`src/core/task-lifecycle.ts`). After saving the subtask, if `parentTaskId` is set, load the parent task, append the new subtask ID to `parent.subtasks`, save the parent, and include the parent file in the same git commit. The git method `addAndCommitTaskFile` is extended to accept optional additional file paths to stage in the same commit.

**Tech Stack:** Bun + TypeScript 5, gray-matter (markdown frontmatter), Bun's native file API, git via shell.

---

### Task 1: Extend `addAndCommitTaskFile` to accept additional file paths

**Files:**
- Modify: `src/git/operations.ts:272-294`

**Step 1: Write the failing test**

In `src/test/integration.test.ts`, add a test inside a new `describe("subtask bidirectional navigation")` block that:
1. Creates a parent task via MCP `task_create`
2. Creates a subtask via MCP `task_create` with `parentTaskId` set
3. Calls MCP `task_view` on the parent
4. Asserts the response contains `subtasks` with the subtask ID

```typescript
describe("subtask bidirectional navigation", () => {
  let env: TestEnv;
  beforeAll(async () => { env = await startTestEnv(); });
  afterAll(async () => { await env.server.stop(); await cleanup(env.projectDir, env.configDir); });

  test("parent task file lists subtask after subtask creation", async () => {
    // Create parent
    const parentRes = await mcpCall(env, "task_create", { title: "Parent Task" });
    const parentId: string = parentRes.result.content[0].text.match(/task-\d+/i)![0];

    // Create subtask
    const subRes = await mcpCall(env, "task_create", { title: "Child Task", parentTaskId: parentId });
    const subId: string = subRes.result.content[0].text.match(new RegExp(`${parentId}\\.\\d+`, "i"))![0];

    // View parent and check subtasks
    const viewRes = await mcpCall(env, "task_view", { id: parentId });
    const text: string = viewRes.result.content[0].text;
    expect(text).toContain(subId.toUpperCase());
  });
});
```

**Step 2: Run the test to confirm it fails**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts 2>&1 | grep -A 5 "bidirectional"
```

Expected: FAIL — parent view does not contain subtask ID.

**Step 3: Extend `addAndCommitTaskFile` with optional `additionalFilePaths`**

In `src/git/operations.ts`, change the signature and body:

```typescript
async addAndCommitTaskFile(
  taskId: string,
  filePath: string,
  action: "create" | "update" | "archive",
  additionalFilePaths?: string[],
): Promise<void> {
  const actionMessages = {
    create: `Create task ${taskId}`,
    update: `Update task ${taskId}`,
    archive: `Archive task ${taskId}`,
  };

  const context = await this.getPathContext(filePath);
  const repoRoot = context?.repoRoot ?? this.projectRoot;
  const pathForAdd = context?.relativePath ?? relative(this.projectRoot, filePath).replace(/\\/g, "/");

  await this.retryGitOperation(async () => {
    await this.resetIndex(repoRoot);
    await this.execGit(["add", pathForAdd], { cwd: repoRoot });

    // Stage additional files in the same commit
    if (additionalFilePaths && additionalFilePaths.length > 0) {
      for (const extra of additionalFilePaths) {
        const extraContext = await this.getPathContext(extra);
        const extraPath = extraContext?.relativePath ?? relative(this.projectRoot, extra).replace(/\\/g, "/");
        await this.execGit(["add", extraPath], { cwd: repoRoot });
      }
    }

    await this.commitStagedChanges(actionMessages[action], repoRoot);
  }, `commit task file ${filePath}`);
}
```

**Step 4: Verify TypeScript compiles**

```bash
bunx tsc --noEmit
```

Expected: no errors.

---

### Task 2: Update parent's `subtasks` array when creating a subtask

**Files:**
- Modify: `src/core/task-lifecycle.ts:136-157`

**Step 1: Add the parent-update logic inside `createTask`**

After the existing `core.fs.saveTask(task)` and content store update, add:

```typescript
// If this is a subtask, update the parent's subtasks list
let parentFilePath: string | undefined;
if (task.parentTaskId) {
  const parent = await core.fs.loadTask(task.parentTaskId);
  if (parent) {
    const existing = parent.subtasks ?? [];
    if (!existing.includes(task.id)) {
      const updatedParent: Task = { ...parent, subtasks: [...existing, task.id] };
      parentFilePath = await core.fs.saveTask(updatedParent);
      if (core.contentStore) {
        const reloaded = await core.fs.loadTask(parent.id);
        if (reloaded) core.contentStore.upsertTask(reloaded);
      }
    }
  }
}
```

Then update the auto-commit block to pass the parent file path:

```typescript
if (await core.shouldAutoCommit(autoCommit)) {
  const additional = parentFilePath ? [parentFilePath] : undefined;
  await core.git.addAndCommitTaskFile(task.id, filepath, "create", additional);
}
```

The full updated `createTask` function:

```typescript
export async function createTask(core: Core, task: Task, autoCommit?: boolean): Promise<string> {
  if (!task.status) {
    const config = await core.fs.loadConfig();
    task.status = config?.defaultStatus || FALLBACK_STATUS;
  }

  normalizeAssignee(task);

  const filepath = await core.fs.saveTask(task);
  if (core.contentStore) {
    const savedTask = await core.fs.loadTask(task.id);
    if (savedTask) {
      core.contentStore.upsertTask(savedTask);
    }
  }

  // If this is a subtask, update the parent's subtasks list
  let parentFilePath: string | undefined;
  if (task.parentTaskId) {
    const parent = await core.fs.loadTask(task.parentTaskId);
    if (parent) {
      const existing = parent.subtasks ?? [];
      if (!existing.includes(task.id)) {
        const updatedParent: Task = { ...parent, subtasks: [...existing, task.id] };
        parentFilePath = await core.fs.saveTask(updatedParent);
        if (core.contentStore) {
          const reloaded = await core.fs.loadTask(parent.id);
          if (reloaded) core.contentStore.upsertTask(reloaded);
        }
      }
    }
  }

  if (await core.shouldAutoCommit(autoCommit)) {
    const additional = parentFilePath ? [parentFilePath] : undefined;
    await core.git.addAndCommitTaskFile(task.id, filepath, "create", additional);
  }

  return filepath;
}
```

**Step 2: Verify TypeScript compiles**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 3: Run the failing test from Task 1**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts 2>&1 | grep -A 10 "bidirectional"
```

Expected: PASS.

**Step 4: Run full test suite**

```bash
CLAUDECODE=1 bun test
```

Expected: all tests pass, no regressions.

**Step 5: Commit**

```bash
git add src/git/operations.ts src/core/task-lifecycle.ts src/test/integration.test.ts
git commit -m "feat: update parent task file with subtask IDs on creation"
```

---

### Task 3: Verify git state and markdown output

**Step 1: Manually verify a parent task file has `subtasks` after creation**

Using the CLI directly:

```bash
bun run cli task create "My Parent"
bun run cli task create "My Child" --parent <PARENT-ID>
cat backlog/tasks/<parent-folder>/<parent-file>.md
```

Expected frontmatter in the parent file:
```yaml
subtasks:
  - TASK-1.1
```

**Step 2: Verify bidirectional view via MCP `task_view`**

```bash
bun run cli task view <PARENT-ID>
```

Expected output includes:
```
Subtasks: TASK-1.1 - My Child
```

```bash
bun run cli task view <CHILD-ID>
```

Expected output includes:
```
Parent: TASK-1 - My Parent
```
