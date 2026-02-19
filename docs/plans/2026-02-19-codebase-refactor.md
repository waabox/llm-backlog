# Codebase Refactor: Eliminate Duplication, Break Circular Dependencies, Split God Files

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean up the forked codebase by eliminating duplicated logic, fixing the circular dependency between core and CLI, and splitting the 3,538-line `cli.ts` into focused command modules.

**Architecture:** The refactor follows a bottom-up approach: first fix the foundational dependency violation (core -> cli), then deduplicate shared utilities into their canonical homes, then split the God files. Each phase leaves all tests passing.

**Tech Stack:** TypeScript 5, Bun runtime, Bun test runner, Biome linting

---

## Phase 1: Fix Circular Dependency (core/backlog.ts -> cli.ts)

The core domain layer dynamically imports `generateNextDocId` and `generateNextDecisionId` from `cli.ts`. These exact functions already exist in `src/utils/id-generators.ts`. This is the highest-impact, lowest-risk fix.

### Task 1: Rewire core/backlog.ts to use utils/id-generators.ts

**Files:**
- Modify: `src/core/backlog.ts:2249` and `src/core/backlog.ts:2298`

**Step 1: Run existing tests to establish baseline**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass.

**Step 2: Update the import in `createDecisionWithTitle`**

In `src/core/backlog.ts`, line 2249, replace:
```typescript
const { generateNextDecisionId } = await import("../cli.js");
```
with:
```typescript
const { generateNextDecisionId } = await import("../utils/id-generators.js");
```

**Step 3: Update the import in `createDocumentWithId`**

In `src/core/backlog.ts`, line 2298, replace:
```typescript
const { generateNextDocId } = await import("../cli.js");
```
with:
```typescript
const { generateNextDocId } = await import("../utils/id-generators.js");
```

**Step 4: Run tests to verify nothing broke**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass.

**Step 5: Commit**

```bash
git add src/core/backlog.ts
git commit -m "Fix circular dependency: core imports id-generators from utils instead of cli"
```

---

### Task 2: Remove duplicate functions from cli.ts

**Files:**
- Modify: `src/cli.ts:1025-1159` (remove `generateNextDocId` and `generateNextDecisionId`)

**Step 1: Remove the duplicate `generateNextDocId` function (lines ~1025-1091)**

Delete the entire `generateNextDocId` function from `cli.ts` and replace it with a re-export or direct import from `utils/id-generators.ts`.

If other code within `cli.ts` calls `generateNextDocId`, add at the top of `cli.ts`:
```typescript
import { generateNextDocId, generateNextDecisionId } from "./utils/id-generators.ts";
```

Then delete the function bodies (lines ~1025-1159).

**Step 2: Remove the duplicate `generateNextDecisionId` function (lines ~1093-1159)**

Same as above - delete the function body.

**Step 3: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass.

**Step 4: Type check**

```bash
bunx tsc --noEmit
```

Expected: No errors.

**Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "Remove duplicate id-generator functions from cli.ts, import from utils"
```

---

## Phase 2: Deduplicate Shared Utilities

### Task 3: Export `stripPrefix`, `parseTaskIdSegments`, and `createTaskIdVariants` from task-search.ts

**Files:**
- Modify: `src/utils/task-search.ts:26,34,38,65` (add `export` keyword to functions)

**Step 1: Add `export` to the shared functions in `src/utils/task-search.ts`**

Change these private functions to exported:
```typescript
export function extractPrefix(id: string): string | null {
export function stripPrefix(id: string): string {
export function createTaskIdVariants(id: string): string[] {
export function parseTaskIdSegments(value: string): number[] | null {
```

**Step 2: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass (adding exports is safe).

**Step 3: Commit**

```bash
git add src/utils/task-search.ts
git commit -m "Export shared task-id utility functions from task-search.ts"
```

---

### Task 4: Deduplicate stripPrefix/parseTaskIdSegments from core/search-service.ts

**Files:**
- Modify: `src/core/search-service.ts`

**Step 1: Replace duplicate functions with imports**

At the top of `src/core/search-service.ts`, add:
```typescript
import { stripPrefix, extractPrefix, parseTaskIdSegments, createTaskIdVariants } from "../utils/task-search.ts";
```

Then delete the local `PREFIX_PATTERN`, `extractPrefix`, `stripPrefix`, `parseTaskIdSegments`, and `createTaskIdVariants` function definitions from the file.

Note: `search-service.ts` calls `stripPrefix(value.toLowerCase())` while `task-search.ts` does `stripPrefix(value)`. Since `PREFIX_PATTERN` is case-insensitive (`/i` flag), the lowercase is redundant. Verify by checking the regex: `/^[a-zA-Z]+-/i` - already case-insensitive. Safe to remove the `.toLowerCase()` in the call or keep it (harmless).

**Step 2: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass.

**Step 3: Type check**

```bash
bunx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/core/search-service.ts
git commit -m "Deduplicate task-id utilities in search-service, import from task-search"
```

---

### Task 5: Deduplicate stripPrefix/parseTaskIdSegments from server/index.ts

**Files:**
- Modify: `src/server/index.ts`

**Step 1: Replace duplicate functions with imports**

At the top of `src/server/index.ts`, add:
```typescript
import { stripPrefix, parseTaskIdSegments } from "../utils/task-search.ts";
```

Then delete the local `PREFIX_PATTERN` constant, `stripPrefix`, and `parseTaskIdSegments` function definitions. Keep `ensurePrefix` as-is (it's only used here and depends on a local `DEFAULT_PREFIX` constant).

**Step 2: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "Deduplicate task-id utilities in server, import from task-search"
```

---

### Task 6: Deduplicate milestoneKey - remove from mcp/utils/milestone-resolution.ts

**Files:**
- Modify: `src/mcp/utils/milestone-resolution.ts`

**Step 1: Import milestoneKey from core instead of defining locally**

In `src/mcp/utils/milestone-resolution.ts`, replace:
```typescript
export function milestoneKey(name: string): string {
	return normalizeMilestoneName(name).toLowerCase();
}
```
with:
```typescript
import { milestoneKey } from "../../core/milestones.ts";
```

Also import `normalizeMilestoneName` from core if it's used elsewhere in the file (check if `normalizeMilestoneName` is also defined locally or imported from core). Currently it's defined locally - keep it or import from core. Since `core/milestones.ts` exports `normalizeMilestoneName`, import from there and remove the local copy.

Replace the local definition:
```typescript
export function normalizeMilestoneName(name: string): string {
	return name.trim();
}
```
with:
```typescript
import { normalizeMilestoneName, milestoneKey } from "../../core/milestones.ts";
```

Re-export if other MCP modules import from this file:
```typescript
export { normalizeMilestoneName, milestoneKey } from "../../core/milestones.ts";
```

**Step 2: Check all importers of milestone-resolution.ts**

Search for files that import `milestoneKey` or `normalizeMilestoneName` from `mcp/utils/milestone-resolution`. If they exist, the re-export ensures they still work.

**Step 3: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 4: Commit**

```bash
git add src/mcp/utils/milestone-resolution.ts
git commit -m "Deduplicate milestoneKey and normalizeMilestoneName, single source in core/milestones"
```

---

### Task 7: Deduplicate collectArchivedMilestoneKeys from mcp/tools/milestones/handlers.ts

**Files:**
- Modify: `src/mcp/tools/milestones/handlers.ts`

**Step 1: Replace local copy with import from core**

In `src/mcp/tools/milestones/handlers.ts`, add:
```typescript
import { collectArchivedMilestoneKeys } from "../../../core/milestones.ts";
```

Then delete the local `collectArchivedMilestoneKeys` function (lines ~35-51).

**Step 2: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 3: Commit**

```bash
git add src/mcp/tools/milestones/handlers.ts
git commit -m "Deduplicate collectArchivedMilestoneKeys, import from core/milestones"
```

---

### Task 8: Deduplicate resolveMilestoneInput in mcp/tools/tasks/handlers.ts

**Files:**
- Modify: `src/mcp/tools/tasks/handlers.ts`

**Step 1: Replace private `resolveMilestoneInput` with `resolveMilestoneStorageValue`**

The canonical function `resolveMilestoneStorageValue(name, milestones)` in `src/mcp/utils/milestone-resolution.ts` (line 106) does exactly what the private method does.

In `src/mcp/tools/tasks/handlers.ts`:
1. Import `resolveMilestoneStorageValue` from `../../utils/milestone-resolution.ts`
2. Find all call sites of the private `resolveMilestoneInput` method
3. Replace calls with `resolveMilestoneStorageValue(input, milestones)` - adjust to load milestones first if the method currently does it internally
4. Delete the private `resolveMilestoneInput` method (~lines 55-168)

**Step 2: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 3: Commit**

```bash
git add src/mcp/tools/tasks/handlers.ts
git commit -m "Deduplicate resolveMilestoneInput in task handlers, use shared resolution"
```

---

### Task 9: Deduplicate resolveMilestoneInput in server/index.ts

**Files:**
- Modify: `src/server/index.ts`

**Step 1: Replace private method with shared utility**

Same approach as Task 8:
1. Import `resolveMilestoneStorageValue` from `../mcp/utils/milestone-resolution.ts`
2. Replace calls to the private `resolveMilestoneInput` method
3. Delete the private method (~lines 118-220)

**Step 2: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 3: Commit**

```bash
git add src/server/index.ts
git commit -m "Deduplicate resolveMilestoneInput in server, use shared resolution"
```

---

## Phase 3: Split cli.ts Into Command Modules

The existing pattern uses two approaches:
- **Pattern A**: `registerXCommand(program)` - the command file owns its Commander registration
- **Pattern B**: `runXCommand(core)` - cli.ts keeps the Commander registration, delegates logic

For consistency and maximum extraction, use **Pattern A** for top-level command groups.

### Task 10: Extract `task` command (~1,000 lines)

**Files:**
- Create: `src/commands/task.ts`
- Modify: `src/cli.ts`

**Step 1: Create `src/commands/task.ts`**

Cut the `task` command group (lines ~1277-2285) from `cli.ts` into a new file:
```typescript
import type { Command } from "commander";
import type { Core } from "../core/backlog.ts";
// ... other imports used by task subcommands

export function registerTaskCommand(program: Command, core: Core): void {
    const task = program
        .command("task")
        .alias("tasks")
        // ... rest of the task command definition
}
```

Move all helper functions used exclusively by task commands (like `buildTaskFromOptions`, `normalizeDependencies`, `validateDependencies`) into this file or into `src/utils/` if shared.

**Step 2: Wire in cli.ts**

Replace the inline task command block with:
```typescript
import { registerTaskCommand } from "./commands/task.ts";
// ... later in the file:
registerTaskCommand(program, core);
```

**Step 3: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 4: Commit**

```bash
git add src/commands/task.ts src/cli.ts
git commit -m "Extract task command group from cli.ts into commands/task.ts"
```

---

### Task 11: Extract `draft` command (~180 lines)

**Files:**
- Create: `src/commands/draft.ts`
- Modify: `src/cli.ts`

Same pattern as Task 10. Cut lines ~2287-2465 into `src/commands/draft.ts`.

**Step 1: Create `src/commands/draft.ts` with `registerDraftCommand(program, core)`**

**Step 2: Wire in cli.ts**

**Step 3: Run tests**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 4: Commit**

```bash
git add src/commands/draft.ts src/cli.ts
git commit -m "Extract draft command from cli.ts into commands/draft.ts"
```

---

### Task 12: Extract `milestone` command (~70 lines)

**Files:**
- Create: `src/commands/milestone.ts`
- Modify: `src/cli.ts`

Cut lines ~2467-2536.

**Step 1-4: Same pattern as Tasks 10-11.**

**Commit:**
```bash
git add src/commands/milestone.ts src/cli.ts
git commit -m "Extract milestone command from cli.ts into commands/milestone.ts"
```

---

### Task 13: Extract `board` command (~200 lines)

**Files:**
- Create: `src/commands/board.ts`
- Modify: `src/cli.ts`

Cut lines ~2538-2738.

**Step 1-4: Same pattern.**

**Commit:**
```bash
git add src/commands/board.ts src/cli.ts
git commit -m "Extract board command from cli.ts into commands/board.ts"
```

---

### Task 14: Extract `doc` command (~80 lines)

**Files:**
- Create: `src/commands/doc.ts`
- Modify: `src/cli.ts`

Cut lines ~2740-2817.

**Commit:**
```bash
git add src/commands/doc.ts src/cli.ts
git commit -m "Extract doc command from cli.ts into commands/doc.ts"
```

---

### Task 15: Extract `decision` command (~25 lines)

**Files:**
- Create: `src/commands/decision.ts`
- Modify: `src/cli.ts`

Cut lines ~2819-2840.

**Commit:**
```bash
git add src/commands/decision.ts src/cli.ts
git commit -m "Extract decision command from cli.ts into commands/decision.ts"
```

---

### Task 16: Extract `agents` command (~55 lines)

**Files:**
- Create: `src/commands/agents.ts`
- Modify: `src/cli.ts`

Cut lines ~2842-2898.

**Commit:**
```bash
git add src/commands/agents.ts src/cli.ts
git commit -m "Extract agents command from cli.ts into commands/agents.ts"
```

---

### Task 17: Extract `config` command (~425 lines)

**Files:**
- Create: `src/commands/config.ts`
- Modify: `src/cli.ts`

Cut lines ~2900-3322. This is the second largest block after `task`.

**Commit:**
```bash
git add src/commands/config.ts src/cli.ts
git commit -m "Extract config command from cli.ts into commands/config.ts"
```

---

### Task 18: Extract `sequence` command (~40 lines)

**Files:**
- Create: `src/commands/sequence.ts`
- Modify: `src/cli.ts`

Cut lines ~2984-3022.

**Commit:**
```bash
git add src/commands/sequence.ts src/cli.ts
git commit -m "Extract sequence command from cli.ts into commands/sequence.ts"
```

---

### Task 19: Extract `cleanup` command (~130 lines)

**Files:**
- Create: `src/commands/cleanup.ts`
- Modify: `src/cli.ts`

Cut lines ~3324-3452.

**Commit:**
```bash
git add src/commands/cleanup.ts src/cli.ts
git commit -m "Extract cleanup command from cli.ts into commands/cleanup.ts"
```

---

### Task 20: Extract `browser` command (~50 lines)

**Files:**
- Create: `src/commands/browser.ts`
- Modify: `src/cli.ts`

Cut lines ~3454-3501.

**Commit:**
```bash
git add src/commands/browser.ts src/cli.ts
git commit -m "Extract browser command from cli.ts into commands/browser.ts"
```

---

### Task 21: Extract `search` command (~215 lines)

**Files:**
- Create: `src/commands/search.ts`
- Modify: `src/cli.ts`

Cut lines ~1418-1631. Note: `search` is registered on `program` directly, not under `task`.

**Commit:**
```bash
git add src/commands/search.ts src/cli.ts
git commit -m "Extract search command from cli.ts into commands/search.ts"
```

---

### Task 22: Extract `init` command (~715 lines)

**Files:**
- Create: `src/commands/init.ts`
- Modify: `src/cli.ts`

Cut lines ~307-1023. This is the largest single command. It already uses helpers from `commands/advanced-config-wizard.ts` and `commands/configure-advanced-settings.ts`.

**Commit:**
```bash
git add src/commands/init.ts src/cli.ts
git commit -m "Extract init command from cli.ts into commands/init.ts"
```

---

### Task 23: Final validation of cli.ts reduction

**Files:**
- Verify: `src/cli.ts` should now be ~300 lines (imports, setup, program configuration, and `registerXCommand` calls)

**Step 1: Run full test suite**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 2: Type check**

```bash
bunx tsc --noEmit
```

**Step 3: Lint check**

```bash
bun run check .
```

**Step 4: Verify cli.ts line count**

```bash
wc -l src/cli.ts
```

Expected: ~200-400 lines (down from 3,538).

**Step 5: Commit any final cleanup**

```bash
git add -A
git commit -m "Complete cli.ts decomposition: 3,538 -> ~300 lines across focused command modules"
```

---

## Phase 4 (Optional): Reorganize Test Directory

This phase is lower priority and can be done separately. The benefit is navigability, not correctness.

### Task 24: Move tests into subdirectories

**Files:**
- Move: 120 test files from `src/test/` into subdirectories

Proposed structure:
```
src/test/
  test-helpers.ts          (stays at root)
  test-utils.ts            (stays at root)
  markdown-test-helpers.ts (stays at root)
  cli/                     (18 files)
  mcp/                     (11 files)
  board/                   (7 files)
  core/                    (filesystem, git, content-store, search, statistics, etc.)
  commands/                (task-edit, draft-create, config, cleanup, etc.)
  markdown/                (5 files)
  sequences/               (5 files)
  ui/                      (tui + board-ui files)
  web/                     (2 files)
  integration/             (offline, auto-commit, git-related)
```

**Step 1: Create subdirectories and move files using `git mv`**

**Step 2: Update any relative imports in test files**

**Step 3: Run full test suite**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

**Step 4: Commit**

```bash
git commit -m "Reorganize test directory into domain-based subdirectories"
```

---

## Summary

| Phase | Tasks | Impact | Risk |
|-------|-------|--------|------|
| 1: Fix circular dependency | 1-2 | High (architectural violation) | Very low |
| 2: Deduplicate utilities | 3-9 | Medium (maintenance burden) | Low |
| 3: Split cli.ts | 10-23 | High (3,538 -> ~300 lines) | Medium |
| 4: Reorganize tests | 24 | Low (navigability) | Low |

**Total estimated tasks:** 24
**Each task is independently committable and leaves tests passing.**
**If any task breaks tests, stop and investigate before proceeding.**
