# Spaghetti Refactor: Milestone Dedup, FileSystem Split, Core Decomposition, Server Split

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the 4 largest sources of spaghetti: duplicated milestone resolution (12 files), monolithic FileSystem (1,396 lines), god-class Core (2,643 lines), and overloaded BacklogServer (1,711 lines).

**Architecture:** Bottom-up execution order. Each phase reduces complexity for the next. All phases preserve existing public APIs (callers don't change).

**Tech Stack:** TypeScript 5, Bun runtime, Bun test runner, Biome linting

---

## Phase 1: Milestone Resolution Deduplication (12 files)

### Problem

The same milestone resolution logic (normalize input, build alias keys, match by numeric ID / m-prefix / title) is copy-pasted in 12 files. `core/milestones.ts` already has canonical functions (`buildMilestoneAliasMap`, `milestoneKey`, `normalizeMilestoneName`) but 9 files reimplement them inline.

### Two Usage Patterns

**Pattern A - "Resolve input to canonical ID":**
```
input: "1" | "m-1" | "Sprint Alpha" → output: "m-1"
```
Used by: server/index.ts, mcp/tools/tasks/handlers.ts, web/TaskDetailsModal.tsx, commands/board.ts

**Pattern B - "Build alias map":**
```
input: milestones[] → output: Map<alias, canonicalId>
```
Used by: web/Board.tsx, web/TaskList.tsx, web/App.tsx, web/lib/lanes.ts

### Solution

#### Task 1: Add `resolveMilestoneInput()` to `core/milestones.ts`

Add a synchronous function covering Pattern A:
```typescript
export function resolveMilestoneInput(
  input: string,
  activeMilestones: Milestone[],
  archivedMilestones?: Milestone[]
): string
```

This consolidates the logic currently duplicated as private methods in server/index.ts (120 lines), mcp/tools/tasks/handlers.ts (95 lines), and inline in web components.

**Files:** Modify `src/core/milestones.ts`

**Verification:** Run tests, type check.

#### Task 2: Replace server/index.ts private `resolveMilestoneInput`

Import `resolveMilestoneInput` from `core/milestones.ts`. Delete the private 120-line method (lines 98-218). Callers load milestones first, then call the shared function.

**Files:** Modify `src/server/index.ts`

#### Task 3: Replace mcp/tools/tasks/handlers.ts private `resolveMilestoneInput`

Same approach. Delete private method (lines 55-150). Import from core.

**Files:** Modify `src/mcp/tools/tasks/handlers.ts`

#### Task 4: Replace mcp/tools/milestones/handlers.ts duplicate functions

Replace `findActiveMilestoneByAlias()`, `buildTaskMatchKeysForMilestone()`, `resolveMilestoneValueForReporting()` with imports from core and mcp/utils/milestone-resolution.ts.

**Files:** Modify `src/mcp/tools/milestones/handlers.ts`

#### Task 5: Replace commands/board.ts inline `resolveMilestoneAlias`

Import `buildMilestoneAliasMap` from core. Delete inline implementation (lines 50-131).

**Files:** Modify `src/commands/board.ts`

#### Task 6: Simplify mcp/utils/milestone-resolution.ts

Reduce to pure re-exports from core, plus MCP-specific `resolveMilestoneStorageValue` wrapper.

**Files:** Modify `src/mcp/utils/milestone-resolution.ts`

#### Task 7: Replace web component inline implementations

Replace duplicate milestone logic in:
- `web/components/Board.tsx` (lines 53-163) → import from `web/utils/milestones`
- `web/components/TaskList.tsx` (lines 77-180) → import from `web/utils/milestones`
- `web/App.tsx` (lines 34-100) → import from `web/utils/milestones`
- `web/lib/lanes.ts` (lines 21-130) → import `buildMilestoneAliasMap` from `web/utils/milestones`
- `web/components/TaskDetailsModal.tsx` (lines 87-150) → import from `web/utils/milestones`

Ensure `web/utils/milestones.ts` re-exports everything needed from core.

**Files:** Modify 5 web files + verify `web/utils/milestones.ts` exports

#### Task 8: Phase 1 verification

Run full test suite, type check, lint check. Verify all 12 files now use shared functions.

**Estimated impact:** ~800-1000 lines of duplicated code eliminated.

---

## Phase 2: FileSystem Split (1,396 lines → ~5 stores + facade)

### Problem

`FileSystem` handles tasks, drafts, documents, decisions, milestones, and config in a single 1,396-line class.

### Solution

Extract logic per entity type into store classes. FileSystem becomes a thin facade that delegates, preserving backward compatibility.

### Target Structure

```
src/file-system/
  operations.ts          # FileSystem class (facade, ~200 lines) - delegates to stores
  shared.ts              # sanitizeFilename(), ensureDirectoryExists(), path helpers
  task-store.ts          # saveTask, loadTask, listTasks, listCompleted, listArchived, archive, complete
  draft-store.ts         # saveDraft, loadDraft, listDrafts, archiveDraft, promote, demote
  document-store.ts      # saveDocument, loadDocument, listDocuments
  decision-store.ts      # saveDecision, loadDecision, listDecisions
  milestone-store.ts     # list, listArchived, load, create, rename, archive + private helpers
  config-store.ts        # loadConfig, saveConfig, parseConfig, serializeConfig, user settings
```

### Rules

- Each store receives `backlogDir` and `projectRoot` in constructor
- FileSystem creates stores and delegates, maintaining backward-compat
- Stores share helpers from `shared.ts` (sanitizeFilename, ensureDirectoryExists)
- Config cache lives in `config-store.ts`

#### Task 9: Extract `shared.ts`

Move `sanitizeFilename()`, `ensureDirectoryExists()` to `src/file-system/shared.ts`. Import in operations.ts.

**Files:** Create `src/file-system/shared.ts`, modify `src/file-system/operations.ts`

#### Task 10: Extract `config-store.ts`

Move `loadConfig`, `saveConfig`, `parseConfig`, `serializeConfig`, `getUserSetting`, `setUserSetting`, `loadUserSettings`, `saveUserSettings`, `invalidateConfigCache` + `cachedConfig` state.

**Files:** Create `src/file-system/config-store.ts`, modify `src/file-system/operations.ts`

#### Task 11: Extract `task-store.ts`

Move `saveTask`, `loadTask`, `listTasks`, `listCompletedTasks`, `listArchivedTasks`, `archiveTask`, `completeTask`.

**Files:** Create `src/file-system/task-store.ts`, modify `src/file-system/operations.ts`

#### Task 12: Extract `draft-store.ts`

Move `saveDraft`, `loadDraft`, `listDrafts`, `archiveDraft`, `promoteDraft`, `demoteTask`.

**Files:** Create `src/file-system/draft-store.ts`, modify `src/file-system/operations.ts`

#### Task 13: Extract `document-store.ts`

Move `saveDocument`, `loadDocument`, `listDocuments`.

**Files:** Create `src/file-system/document-store.ts`, modify `src/file-system/operations.ts`

#### Task 14: Extract `decision-store.ts`

Move `saveDecision`, `loadDecision`, `listDecisions`.

**Files:** Create `src/file-system/decision-store.ts`, modify `src/file-system/operations.ts`

#### Task 15: Extract `milestone-store.ts`

Move `listMilestones`, `listArchivedMilestones`, `loadMilestone`, `createMilestone`, `renameMilestone`, `archiveMilestone` + all private milestone helpers (`findMilestoneFile`, `buildMilestoneIdentifierKeys`, `buildMilestoneFilename`, `serializeMilestoneContent`, `rewriteDefaultMilestoneDescription`).

**Files:** Create `src/file-system/milestone-store.ts`, modify `src/file-system/operations.ts`

#### Task 16: Wire FileSystem as facade

FileSystem constructor creates store instances. All public methods delegate to the appropriate store. Verify no direct callers break.

**Files:** Modify `src/file-system/operations.ts`

#### Task 17: Phase 2 verification

Run full test suite, type check, lint check.

**Estimated impact:** operations.ts drops from 1,396 to ~200 lines. Each store is independently testable.

---

## Phase 3: Core Decomposition (2,643 lines → ~400 lines Core + services)

### Problem

Core has 57+ public methods covering: task lifecycle, archival, acceptance criteria, decisions, documents, ID generation, config migration, search, content store.

### Solution

Extract internal services that Core instantiates and delegates to. Core's public API does not change.

### Target Structure

```
src/core/
  backlog.ts              # Core class (~400 lines) - facade, lazy services
  task-mutation.ts        # applyTaskUpdateInput() (450 lines → own file), normalization helpers
  task-lifecycle.ts       # create, update, promote, demote, bulk update, reorder
  archive-service.ts      # archiveTask, completeTask, archiveDraft, sanitizeArchivedTaskLinks
  task-query.ts           # queryTasks, loadTasks, loadAllTasksForStatistics, loadTaskById, filters
  acceptance-criteria.ts  # add, remove, check, list acceptance criteria
  entity-service.ts       # decisions + documents (create, update, getContent)
  id-generation.ts        # generateNextId, getExistingIdsForType (move from backlog.ts)
  config-migration.ts     # consolidate legacy parsing (partially exists)
```

### What Remains in Core

- Constructor, lazy service creation
- `fs`, `git` references
- ContentStore/SearchService lifecycle
- Pure delegation to services

### Service Dependencies

```
task-mutation.ts      → standalone (pure functions)
task-lifecycle.ts     → task-mutation, FileSystem, GitOps
archive-service.ts    → FileSystem, GitOps, task-mutation (sanitize)
task-query.ts         → FileSystem, ContentStore, SearchService
acceptance-criteria.ts → FileSystem, GitOps
entity-service.ts     → FileSystem, GitOps, id-generation
id-generation.ts      → FileSystem
config-migration.ts   → FileSystem
```

#### Task 18: Extract `task-mutation.ts`

Move `applyTaskUpdateInput()` (450 lines), `requireCanonicalStatus()`, `normalizePriority()`, `isExactTaskReference()`.

**Files:** Create `src/core/task-mutation.ts`, modify `src/core/backlog.ts`

#### Task 19: Extract `task-lifecycle.ts`

Move `createTaskFromInput`, `createTask`, `createDraft`, `updateTask`, `updateTaskFromInput`, `updateDraft`, `updateDraftFromInput`, `editTaskOrDraft`, `updateTasksBulk`, `promoteDraftWithUpdates`, `demoteTaskWithUpdates`, `reorderTask`, `listActiveSequences`, `moveTaskInSequences`.

**Files:** Create `src/core/task-lifecycle.ts`, modify `src/core/backlog.ts`

#### Task 20: Extract `archive-service.ts`

Move `archiveTask`, `completeTask`, `archiveDraft`, `promoteDraft`, `demoteTask`, `getDoneTasksByAge`, `sanitizeArchivedTaskLinks`, `archiveMilestone`.

**Files:** Create `src/core/archive-service.ts`, modify `src/core/backlog.ts`

#### Task 21: Extract `task-query.ts`

Move `queryTasks`, `getTask`, `getTaskWithSubtasks`, `loadTaskById`, `getTaskContent`, `loadTasks`, `loadAllTasksForStatistics`, `listTasksWithMetadata`, `applyTaskFilters`, `filterLocalEditableTasks`.

**Files:** Create `src/core/task-query.ts`, modify `src/core/backlog.ts`

#### Task 22: Extract `acceptance-criteria.ts`

Move `addAcceptanceCriteria`, `removeAcceptanceCriteria`, `checkAcceptanceCriteria`, `listAcceptanceCriteria`.

**Files:** Create `src/core/acceptance-criteria.ts`, modify `src/core/backlog.ts`

#### Task 23: Extract `entity-service.ts`

Move decision methods (`createDecision`, `updateDecisionFromContent`, `createDecisionWithTitle`) and document methods (`createDocument`, `updateDocument`, `createDocumentWithId`, `getDocument`, `getDocumentContent`).

**Files:** Create `src/core/entity-service.ts`, modify `src/core/backlog.ts`

#### Task 24: Extract `id-generation.ts` (consolidate)

Move `generateNextId` and `getExistingIdsForType` from backlog.ts. Note: `src/utils/id-generators.ts` already exists with simpler ID generators. This is the cross-branch-aware version.

**Files:** Create `src/core/id-generation.ts`, modify `src/core/backlog.ts`

#### Task 25: Consolidate `config-migration.ts`

Move all legacy config parsing methods: `ensureConfigMigrated`, `parseLegacyInlineArray`, `stripYamlComment`, `parseLegacyYamlValue`, `extractLegacyConfigMilestones`, `migrateLegacyConfigMilestonesToFiles`.

**Files:** Modify/expand `src/core/config-migration.ts`, modify `src/core/backlog.ts`

#### Task 26: Wire Core as facade

Core constructor lazily creates services. All public methods delegate. Run full verification.

**Files:** Modify `src/core/backlog.ts`

#### Task 27: Phase 3 verification

Run full test suite, type check, lint check. Verify Core public API unchanged.

**Estimated impact:** backlog.ts drops from 2,643 to ~400 lines.

---

## Phase 4: Server Split (1,711 lines → modules by domain)

### Problem

BacklogServer has 40+ route handlers, WebSocket management, Auth, MCP transport, milestone resolution, asset serving - all in one file.

### Solution

Extract route handlers by domain. BacklogServer stays as HTTP orchestrator.

### Target Structure

```
src/server/
  index.ts               # BacklogServer (~300 lines) - Bun.serve(), WebSocket, lifecycle
  routes/
    tasks.ts             # 10 task routes
    milestones.ts        # 5 milestone routes
    documents.ts         # 5 document routes
    decisions.ts         # 5 decision routes
    drafts.ts            # 2 draft routes
    sequences.ts         # 2 sequence routes
    config.ts            # 4 config/status/init routes
    search.ts            # 4 search/stats/version routes
    auth.ts              # 3 auth routes
    assets.ts            # static asset serving
  middleware/
    auth.ts              # protect(), authenticateRequest()
```

### Route Registration Pattern

Each module exports:
```typescript
export function registerTaskRoutes(router: RouteMap, deps: RouteDeps): void
```

Where `RouteDeps` contains `core`, `contentStore`, `searchService`, `broadcastTasksUpdated`, etc.

### What Remains in index.ts

- `BacklogServer` class with `start()` / `stop()`
- WebSocket setup + broadcast helpers
- `Bun.serve()` with route registration calls
- ContentStore/SearchService lifecycle
- MCP handler mount

#### Task 28: Extract `middleware/auth.ts`

Move `protect()`, `authenticateRequest()` and related auth logic.

**Files:** Create `src/server/middleware/auth.ts`, modify `src/server/index.ts`

#### Task 29: Extract `routes/tasks.ts`

Move all 10 task route handlers.

**Files:** Create `src/server/routes/tasks.ts`, modify `src/server/index.ts`

#### Task 30: Extract `routes/milestones.ts`

Move 5 milestone route handlers. Since Phase 1 already eliminated the duplicate `resolveMilestoneInput`, these handlers import from core.

**Files:** Create `src/server/routes/milestones.ts`, modify `src/server/index.ts`

#### Task 31: Extract `routes/documents.ts`

Move 5 document route handlers.

**Files:** Create `src/server/routes/documents.ts`, modify `src/server/index.ts`

#### Task 32: Extract `routes/decisions.ts`

Move 5 decision route handlers.

**Files:** Create `src/server/routes/decisions.ts`, modify `src/server/index.ts`

#### Task 33: Extract `routes/drafts.ts`

Move 2 draft route handlers.

**Files:** Create `src/server/routes/drafts.ts`, modify `src/server/index.ts`

#### Task 34: Extract `routes/sequences.ts`

Move 2 sequence route handlers (both legacy and modern paths).

**Files:** Create `src/server/routes/sequences.ts`, modify `src/server/index.ts`

#### Task 35: Extract `routes/config.ts`

Move config, statuses, init route handlers.

**Files:** Create `src/server/routes/config.ts`, modify `src/server/index.ts`

#### Task 36: Extract `routes/search.ts`

Move search, statistics, version, status route handlers.

**Files:** Create `src/server/routes/search.ts`, modify `src/server/index.ts`

#### Task 37: Extract `routes/auth.ts`

Move auth routes (google login, /me, /auth/status).

**Files:** Create `src/server/routes/auth.ts`, modify `src/server/index.ts`

#### Task 38: Extract `routes/assets.ts`

Move static asset serving and favicon handling.

**Files:** Create `src/server/routes/assets.ts`, modify `src/server/index.ts`

#### Task 39: Wire BacklogServer with route registration

Replace inline route definitions with `registerXRoutes(router, deps)` calls.

**Files:** Modify `src/server/index.ts`

#### Task 40: Phase 4 verification

Run full test suite, type check, lint check. Verify all routes still respond correctly.

**Estimated impact:** index.ts drops from 1,711 to ~300 lines.

---

## Summary

| Phase | Tasks | Before | After | Impact |
|-------|-------|--------|-------|--------|
| 1: Milestone dedup | 1-8 | 12 files with copies | 1 source of truth | ~800-1000 lines eliminated |
| 2: FileSystem split | 9-17 | 1,396 line class | ~200 line facade + 6 stores | Better testability |
| 3: Core decomposition | 18-27 | 2,643 line class | ~400 line facade + 8 services | Independent services |
| 4: Server split | 28-40 | 1,711 line server | ~300 line server + 10 route modules | Domain separation |

**Total tasks:** 40
**Each task is independently committable and leaves tests passing.**
**If any task breaks tests, stop and investigate before proceeding.**
