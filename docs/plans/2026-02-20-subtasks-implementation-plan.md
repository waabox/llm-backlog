# Sub-tasks: Folder-Based Task Structure Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Change task storage from flat `.md` files to ID-named folders, adding sub-task support with a `SubTasks/` subdirectory.

**Architecture:** Every task lives in a folder named by its ID (e.g., `task-1/task-1 - Title.md`). Subtasks live in a `SubTasks/` subfolder of the parent (`task-1/SubTasks/task-1.1 - Sub.md`). Archive and complete move the entire parent folder. Five files require changes: `task-path.ts`, `task-store.ts`, `task-loader.ts`, `archive-service.ts`, and the integration test.

**Tech Stack:** Bun, TypeScript 5, Bun.Glob for filesystem scanning, gray-matter for markdown parsing.

---

## Before You Start

Read these files to understand the current code:
- `src/utils/task-path.ts` — path resolution helpers
- `src/file-system/task-store.ts` — save/list/archive/complete
- `src/core/task-loader.ts` — cross-branch ID extraction
- `src/core/archive-service.ts` — archive and complete orchestration
- `src/test/integration.test.ts` — test fixture (look at `buildProjectRepo`)

The new directory layout:
```
backlog/
  tasks/
    task-1/                          ← folder named by ID (lowercase, no title)
      task-1 - Title.md              ← .md keeps the full "ID - Title" name
      SubTasks/                      ← only created when first subtask added
        task-1.1 - Sub title.md
    task-2/
      task-2 - Other.md
  completed/
    task-3/
      task-3 - Done.md
  archive/tasks/
    task-4/
      task-4 - Archived.md
```

---

## Task 1: Add path helpers in `task-path.ts`

**Files:**
- Modify: `src/utils/task-path.ts`

### Step 1: Write the failing test

Add a test group to `src/test/integration.test.ts` that will verify subtask creation produces the right folder structure. The test will fail because the feature doesn't exist yet.

```typescript
describe("subtask folder structure", () => {
  // This test verifies that tasks are stored in folders and subtasks in SubTasks/
  // Will pass after all tasks are complete
  test("task is saved inside an ID-named folder", async () => {
    // ... (fill in after implementing)
  });
});
```

Actually — skip writing integration tests for now. The integration tests are long. We'll run the existing suite to confirm nothing is broken after each task.

### Step 2: Add helper functions to `src/utils/task-path.ts`

Add these three functions before the existing `getTaskPath` function:

```typescript
/**
 * Returns true if a task ID is a subtask (dot notation like TASK-1.1).
 */
export function isSubtaskId(taskId: string): boolean {
	const body = extractTaskBody(taskId);
	return body !== null && body.includes(".");
}

/**
 * Extracts the top-level parent ID from a subtask ID.
 * TASK-1.1 → TASK-1, TASK-1.2.3 → TASK-1
 */
export function getTopLevelParentId(subtaskId: string, prefix: string = DEFAULT_TASK_PREFIX): string {
	const body = extractTaskBody(subtaskId, prefix);
	if (!body || !body.includes(".")) return subtaskId;
	const parentBody = body.split(".")[0];
	return normalizeTaskId(`${prefix}-${parentBody}`, prefix);
}

/**
 * Returns the directory that contains the task's .md file within a given base dir.
 * For TASK-1: returns {baseDir}/task-1/
 * For TASK-1.1: returns {baseDir}/task-1/SubTasks/
 */
export function getTaskContainerDir(taskId: string, baseDir: string): string {
	const prefix = extractAnyPrefix(taskId) ?? DEFAULT_TASK_PREFIX;
	if (isSubtaskId(taskId)) {
		const parentId = getTopLevelParentId(taskId, prefix);
		return join(baseDir, idForFilename(parentId), "SubTasks");
	}
	return join(baseDir, idForFilename(normalizeTaskId(taskId, prefix)));
}
```

### Step 3: Update `getTaskPath` to scan inside the container directory

Replace the current `getTaskPath` implementation. The key change: instead of scanning `*.md` flat in `tasksDir`, scan inside `getTaskContainerDir(taskId, tasksDir)`.

```typescript
export async function getTaskPath(taskId: string, core?: Core | TaskPathContext): Promise<string | null> {
	const coreInstance = core || new Core(process.cwd());
	const detectedPrefix = extractAnyPrefix(taskId);

	if (detectedPrefix) {
		const containerDir = getTaskContainerDir(taskId, coreInstance.filesystem.tasksDir);
		const globPattern = buildGlobPattern(detectedPrefix);
		try {
			const files = await Array.fromAsync(
				new Bun.Glob(globPattern).scan({ cwd: containerDir, followSymlinks: true }),
			);
			const taskFile = findMatchingFile(files, taskId, detectedPrefix);
			if (taskFile) {
				return join(containerDir, taskFile);
			}
		} catch {
			// fall through
		}
		return null;
	}

	// For numeric-only IDs: scan all task folders looking for a match
	try {
		const allDirs = await Array.fromAsync(
			new Bun.Glob("*/").scan({ cwd: coreInstance.filesystem.tasksDir, followSymlinks: true }),
		);
		const numericPart = taskId.trim();
		for (const dir of allDirs) {
			const dirPath = join(coreInstance.filesystem.tasksDir, dir);
			const filesInDir = await Array.fromAsync(
				new Bun.Glob("*.md").scan({ cwd: dirPath, followSymlinks: true }),
			);
			for (const file of filesInDir) {
				const filePrefix = extractAnyPrefix(file);
				if (filePrefix) {
					const fileBody = extractTaskBodyFromFilename(file, filePrefix);
					if (fileBody && numericPartsEqual(numericPart, fileBody)) {
						return join(dirPath, file);
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}
```

### Step 4: Update `getTaskFilename` to return a relative path from tasksDir

The archive-service uses `getTaskFilename` to build the destination path via `join(archiveDir, taskFilename)`. By returning a relative path that includes the folder, the destination paths are automatically correct.

```typescript
export async function getTaskFilename(taskId: string, core?: Core | TaskPathContext): Promise<string | null> {
	const coreInstance = core || new Core(process.cwd());
	const detectedPrefix = extractAnyPrefix(taskId);

	if (detectedPrefix) {
		const containerDir = getTaskContainerDir(taskId, coreInstance.filesystem.tasksDir);
		const globPattern = buildGlobPattern(detectedPrefix);
		try {
			const files = await Array.fromAsync(
				new Bun.Glob(globPattern).scan({ cwd: containerDir, followSymlinks: true }),
			);
			const taskFile = findMatchingFile(files, taskId, detectedPrefix);
			if (!taskFile) return null;
			// Return relative path from tasksDir, e.g. "task-1/task-1 - Title.md"
			// or "task-1/SubTasks/task-1.1 - Title.md"
			const relativeContainer = containerDir.slice(coreInstance.filesystem.tasksDir.length + 1);
			return join(relativeContainer, taskFile);
		} catch {
			return null;
		}
	}

	// Numeric-only fallback: same logic as getTaskPath but return relative
	try {
		const allDirs = await Array.fromAsync(
			new Bun.Glob("*/").scan({ cwd: coreInstance.filesystem.tasksDir, followSymlinks: true }),
		);
		const numericPart = taskId.trim();
		for (const dir of allDirs) {
			const dirPath = join(coreInstance.filesystem.tasksDir, dir);
			const filesInDir = await Array.fromAsync(
				new Bun.Glob("*.md").scan({ cwd: dirPath, followSymlinks: true }),
			);
			for (const file of filesInDir) {
				const filePrefix = extractAnyPrefix(file);
				if (filePrefix) {
					const fileBody = extractTaskBodyFromFilename(file, filePrefix);
					if (fileBody && numericPartsEqual(numericPart, fileBody)) {
						return join(dir, file); // relative from tasksDir
					}
				}
			}
		}
		return null;
	} catch {
		return null;
	}
}
```

### Step 5: Run existing tests

```bash
CLAUDECODE=1 bun test
```

Expected: tests should still pass (no behavior has changed yet for callers, just internal path logic). Some tests may fail if any test writes tasks — that's expected.

### Step 6: Commit

```bash
git add src/utils/task-path.ts
git commit -m "feat: add folder-based path helpers for task structure"
```

---

## Task 2: Update `task-store.ts` to write and read folder structure

**Files:**
- Modify: `src/file-system/task-store.ts`

### Step 1: Update `saveTask` to write inside the task folder

Current: `filepath = join(this.tasksDir, filename)`
New: `filepath = join(getTaskContainerDir(taskId, this.tasksDir), filename)`

Also import `getTaskContainerDir` and `isSubtaskId` from `task-path.ts`.

```typescript
async saveTask(task: Task): Promise<string> {
	let prefix = extractAnyPrefix(task.id);
	if (!prefix) {
		const config = await this.loadConfig();
		prefix = config?.prefixes?.task ?? "task";
	}
	const taskId = normalizeId(task.id, prefix);
	const filename = `${idForFilename(taskId)} - ${sanitizeFilename(task.title)}.md`;
	const containerDir = getTaskContainerDir(taskId, this.tasksDir);
	const filepath = join(containerDir, filename);

	const normalizedTask = {
		...task,
		id: taskId,
		parentTaskId: task.parentTaskId
			? normalizeId(task.parentTaskId, extractAnyPrefix(task.parentTaskId) ?? prefix)
			: undefined,
	};
	const content = serializeTask(normalizedTask);

	// Delete any existing task file with same ID but different filename
	try {
		const core = { filesystem: { tasksDir: this.tasksDir } };
		const existingPath = await getTaskPath(taskId, core as TaskPathContext);
		if (existingPath && !existingPath.endsWith(filename)) {
			await unlink(existingPath);
		}
	} catch {
		// Ignore
	}

	await ensureDirectoryExists(containerDir);
	await Bun.write(filepath, content);
	return filepath;
}
```

### Step 2: Update `listTasks` to scan inside subfolders

Replace the glob scan to look inside task folders:
- Top-level tasks: `*/task-*.md`
- Subtasks: `*/SubTasks/task-*.md`

```typescript
async listTasks(filter?: TaskListFilter): Promise<Task[]> {
	const config = await this.loadConfig();
	const taskPrefix = (config?.prefixes?.task ?? "task").toLowerCase();
	const globPattern = buildGlobPattern(taskPrefix);

	let taskFiles: string[] = [];
	try {
		const topLevel = await Array.fromAsync(
			new Bun.Glob(`*/${globPattern}`).scan({ cwd: this.tasksDir, followSymlinks: true }),
		);
		const subtasks = await Array.fromAsync(
			new Bun.Glob(`*/SubTasks/${globPattern}`).scan({ cwd: this.tasksDir, followSymlinks: true }),
		);
		taskFiles = [...topLevel, ...subtasks];
	} catch {
		return [];
	}

	let tasks: Task[] = [];
	for (const file of taskFiles) {
		const filepath = join(this.tasksDir, file);
		try {
			const content = await Bun.file(filepath).text();
			const task = normalizeTaskIdentity(parseTask(content));
			tasks.push({ ...task, filePath: filepath });
		} catch (error) {
			if (process.env.DEBUG) {
				console.error(`Failed to parse task file ${filepath}`, error);
			}
		}
	}

	if (filter?.status) {
		const statusLower = filter.status.toLowerCase();
		tasks = tasks.filter((t) => t.status.toLowerCase() === statusLower);
	}
	if (filter?.assignee) {
		const assignee = filter.assignee;
		tasks = tasks.filter((t) => t.assignee.includes(assignee));
	}

	return sortByTaskId(tasks);
}
```

### Step 3: Update `listCompletedTasks` and `listArchivedTasks` with the same pattern

Apply the same two-glob approach (`*/${globPattern}` and `*/SubTasks/${globPattern}`) in `listCompletedTasks` and `listArchivedTasks`, replacing the current single-glob scan.

### Step 4: Update `archiveTask` and `completeTask` to move the folder

For top-level tasks, move the entire folder. For subtasks, move just the file.

```typescript
async archiveTask(taskId: string): Promise<boolean> {
	try {
		const prefix = extractAnyPrefix(taskId) ?? "task";
		const normalized = normalizeId(taskId, prefix);

		if (isSubtaskId(normalized)) {
			// Subtask: move just the .md file
			const core = { filesystem: { tasksDir: this.tasksDir } };
			const sourcePath = await getTaskPath(normalized, core as TaskPathContext);
			const relativeFilename = await getTaskFilename(normalized, core as TaskPathContext);
			if (!sourcePath || !relativeFilename) return false;
			const targetPath = join(this.archiveTasksDir, relativeFilename);
			await ensureDirectoryExists(dirname(targetPath));
			await rename(sourcePath, targetPath);
		} else {
			// Top-level: move entire folder
			const folderName = idForFilename(normalized);
			const sourceFolder = join(this.tasksDir, folderName);
			const targetFolder = join(this.archiveTasksDir, folderName);
			await ensureDirectoryExists(dirname(targetFolder));
			await rename(sourceFolder, targetFolder);
		}
		return true;
	} catch {
		return false;
	}
}

async completeTask(taskId: string): Promise<boolean> {
	try {
		const prefix = extractAnyPrefix(taskId) ?? "task";
		const normalized = normalizeId(taskId, prefix);

		if (isSubtaskId(normalized)) {
			const core = { filesystem: { tasksDir: this.tasksDir } };
			const sourcePath = await getTaskPath(normalized, core as TaskPathContext);
			const relativeFilename = await getTaskFilename(normalized, core as TaskPathContext);
			if (!sourcePath || !relativeFilename) return false;
			const targetPath = join(this.completedDir, relativeFilename);
			await ensureDirectoryExists(dirname(targetPath));
			await rename(sourcePath, targetPath);
		} else {
			const folderName = idForFilename(normalized);
			const sourceFolder = join(this.tasksDir, folderName);
			const targetFolder = join(this.completedDir, folderName);
			await ensureDirectoryExists(dirname(targetFolder));
			await rename(sourceFolder, targetFolder);
		}
		return true;
	} catch {
		return false;
	}
}
```

### Step 5: Add missing imports

At the top of `task-store.ts`, add the new imports:

```typescript
import { getTaskContainerDir, getTaskFilename, getTaskPath, isSubtaskId, normalizeTaskIdentity } from "../utils/task-path.ts";
```

### Step 6: Run tests

```bash
CLAUDECODE=1 bun test
```

### Step 7: Commit

```bash
git add src/file-system/task-store.ts
git commit -m "feat: write and read tasks from folder-based structure"
```

---

## Task 3: Fix cross-branch task loading in `task-loader.ts`

**Files:**
- Modify: `src/core/task-loader.ts`

**Problem:** `buildPathIdRegex` matches `task-1` anywhere in a path. For the path `backlog/tasks/task-1/SubTasks/task-1.1 - Sub.md`, it matches `task-1` (from the folder name) instead of `task-1.1` (from the filename). Fix: extract the ID from the filename (last path segment) only.

### Step 1: Find the `buildRemoteTaskIndex` function

In `task-loader.ts`, find this code block (around line 132-140):

```typescript
for (const f of files) {
    // Extract task ID from filename using configured prefix
    const m = f.match(idRegex);
    if (!m?.[1]) continue;

    const id = normalizeId(m[1], prefix);
```

### Step 2: Fix to use filename only

Replace with:

```typescript
for (const f of files) {
    // Extract task ID from the filename (last path segment) to avoid
    // matching the parent folder name instead of the subtask ID
    const filename = f.split("/").pop() ?? f;
    const m = filename.match(idRegex);
    if (!m?.[1]) continue;

    const id = normalizeId(m[1], prefix);
```

### Step 3: Apply the same fix to `loadLocalBranchTasks` if it has similar code

Search for other `f.match(idRegex)` patterns in `task-loader.ts` and apply the same `f.split("/").pop()` fix.

Run:
```bash
grep -n "\.match(idRegex)" src/core/task-loader.ts
```

Fix each occurrence found.

### Step 4: Run tests

```bash
CLAUDECODE=1 bun test
```

### Step 5: Commit

```bash
git add src/core/task-loader.ts
git commit -m "fix: extract task ID from filename only, not full path"
```

---

## Task 4: Update `archive-service.ts` git staging for folder moves

**Files:**
- Modify: `src/core/archive-service.ts`

**Problem:** `stageFileMove` stages one file's move. When a top-level task folder moves (e.g., `tasks/task-1/` → `archive/tasks/task-1/`), all files inside move but only the parent `.md` is staged. Fix: use `stageBacklogDirectory` for top-level task moves.

### Step 1: Update `archiveTask` in `archive-service.ts`

Import `isSubtaskId` at the top:
```typescript
import { getTaskFilename, getTaskPath, isSubtaskId, normalizeTaskId } from "../utils/task-path.ts";
```

Find the `archiveTask` function. Replace the git staging block:

```typescript
if (await core.shouldAutoCommit(autoCommit)) {
    if (isSubtaskId(normalizedTaskId)) {
        // Single file move — stage precisely
        const repoRoot = await core.git.stageFileMove(fromPath, toPath);
        for (const sanitizedTask of sanitizedTasks) {
            if (sanitizedTask.filePath) await core.git.addFile(sanitizedTask.filePath);
        }
        await core.git.commitChanges(`backlog: Archive task ${normalizedTaskId}`, repoRoot);
    } else {
        // Folder move — stage the whole backlog directory
        const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
        await core.git.commitChanges(`backlog: Archive task ${normalizedTaskId}`, repoRoot);
    }
}
```

### Step 2: Update `completeTask` in `archive-service.ts` with the same pattern

Find `completeTask`. Replace its git staging:

```typescript
if (success && (await core.shouldAutoCommit(autoCommit))) {
    if (isSubtaskId(normalizeTaskId(taskId))) {
        const repoRoot = await core.git.stageFileMove(fromPath, toPath);
        await core.git.commitChanges(`backlog: Complete task ${normalizeTaskId(taskId)}`, repoRoot);
    } else {
        const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
        await core.git.commitChanges(`backlog: Complete task ${normalizeTaskId(taskId)}`, repoRoot);
    }
}
```

### Step 3: Run tests

```bash
CLAUDECODE=1 bun test
```

### Step 4: Commit

```bash
git add src/core/archive-service.ts
git commit -m "fix: stage full backlog directory when archiving top-level task folders"
```

---

## Task 5: Update integration test fixture

**Files:**
- Modify: `src/test/integration.test.ts`

**Problem:** The test `buildProjectRepo` writes task files flat (e.g., `backlog/tasks/task-1 - Initial Task.md`). With the new structure, they must be in folders.

### Step 1: Find the `buildProjectRepo` function

Search for `TASK_1_MD` usage and `backlog/tasks/` path construction in `integration.test.ts`.

### Step 2: Update the task file path

Find the line that writes `TASK_1_MD` (and any other task files). Change from:

```typescript
await writeFile(join(dir, "backlog", "tasks", "task-1 - Initial Task.md"), TASK_1_MD);
```

To:

```typescript
await mkdir(join(dir, "backlog", "tasks", "task-1"), { recursive: true });
await writeFile(join(dir, "backlog", "tasks", "task-1", "task-1 - Initial Task.md"), TASK_1_MD);
```

Apply the same pattern for any other task files written in the fixture.

### Step 3: Run tests

```bash
CLAUDECODE=1 bun test
```

All tests must pass. Fix any remaining path issues found.

### Step 4: Commit

```bash
git add src/test/integration.test.ts
git commit -m "test: update fixture to use folder-based task structure"
```

---

## Task 6: Verify subtask creation end-to-end

This task verifies the full flow works: create a task, then create a subtask, check the folder structure on disk.

### Step 1: Run a manual end-to-end check

```bash
cd /tmp && mkdir test-subtasks && cd test-subtasks
git init && git config user.email "t@t.com" && git config user.name "T"
bun run /Users/waabox/code/waabox/llm-backlog/src/cli.ts init --name "Test"
bun run /Users/waabox/code/waabox/llm-backlog/src/cli.ts task create "Parent task"
bun run /Users/waabox/code/waabox/llm-backlog/src/cli.ts task create --parent TASK-1 "Subtask one"
```

### Step 2: Verify folder structure

```bash
find backlog/tasks -type f
```

Expected output:
```
backlog/tasks/task-1/task-1 - Parent task.md
backlog/tasks/task-1/SubTasks/task-1.1 - Subtask one.md
```

### Step 3: Run full test suite one final time

```bash
cd /Users/waabox/code/waabox/llm-backlog
CLAUDECODE=1 bun test
```

All tests must pass.

### Step 4: Commit

```bash
git add -A
git commit -m "feat: folder-based task structure with sub-tasks support"
```

---

## Notes

- `idForFilename("TASK-1")` returns `"task-1"` — folder names use lowercase, matching the `.md` filename convention.
- The `SubTasks/` directory name is case-sensitive exactly as spelled.
- Drafts (`DRAFT-X`) use the same logic — `DraftStore` may need similar updates if drafts also support sub-tasks. Out of scope for now.
- The `task_loader.ts` cross-branch path handling only needed the filename extraction fix; the folder structure in git paths is automatically handled.
