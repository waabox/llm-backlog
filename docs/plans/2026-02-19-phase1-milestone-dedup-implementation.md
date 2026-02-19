# Phase 1: Milestone Resolution Deduplication - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate 12 duplicate implementations of milestone resolution logic, consolidating into `core/milestones.ts` as the single source of truth.

**Architecture:** Bottom-up: first export the canonical functions from core, then add the missing `resolveMilestoneInput` function, then replace each duplicate one-by-one. Each task leaves all tests passing.

**Tech Stack:** TypeScript 5, Bun runtime, Bun test runner, Biome linting

---

## Task 1: Export `buildMilestoneAliasMap` and `canonicalizeMilestoneValue` from core

These two functions are currently private in `src/core/milestones.ts`. They need to be exported because:
- `buildMilestoneAliasMap` is duplicated in 5 web files + `commands/board.ts`
- `canonicalizeMilestoneValue` is duplicated as `canonicalizeMilestone` in web components

**Files:**
- Modify: `src/core/milestones.ts:58` and `src/core/milestones.ts:176`

**Step 1: Add `export` to `buildMilestoneAliasMap`**

In `src/core/milestones.ts`, line 58, change:
```typescript
function buildMilestoneAliasMap(
```
to:
```typescript
export function buildMilestoneAliasMap(
```

**Step 2: Add `export` to `canonicalizeMilestoneValue`**

In `src/core/milestones.ts`, line 176, change:
```typescript
function canonicalizeMilestoneValue(value: string | null | undefined, aliasMap: Map<string, string>): string {
```
to:
```typescript
export function canonicalizeMilestoneValue(value: string | null | undefined, aliasMap: Map<string, string>): string {
```

**Step 3: Run tests to verify nothing broke**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass (adding exports is always safe).

**Step 4: Type check**

```bash
bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/core/milestones.ts
git commit -m "Export buildMilestoneAliasMap and canonicalizeMilestoneValue from core/milestones"
```

---

## Task 2: Add `resolveMilestoneInput` to `core/milestones.ts`

This function covers "Pattern A" - resolve a user input string (like `"1"`, `"m-1"`, `"Sprint Alpha"`) to a canonical milestone ID, considering both active and archived milestones. It replaces the ~120-line private methods duplicated in server/index.ts and mcp/tools/tasks/handlers.ts.

**Files:**
- Modify: `src/core/milestones.ts` (add new exported function)

**Step 1: Write the function**

Add this after the existing `milestoneKey` function (after line 17) in `src/core/milestones.ts`:

```typescript
/**
 * Resolve a user-provided milestone input to a canonical milestone ID.
 *
 * Handles numeric IDs ("1"), m-prefixed IDs ("m-1"), and title-based lookups.
 * Prioritizes active milestones over archived ones.
 * For ID-looking inputs: active ID > archived ID > active unique title > archived unique title.
 * For title-looking inputs: active unique title > active ID > archived unique title > archived ID.
 *
 * @returns The resolved milestone ID, or the normalized input if no match found.
 */
export function resolveMilestoneInput(
	input: string,
	activeMilestones: Milestone[],
	archivedMilestones: Milestone[] = [],
): string {
	const normalized = normalizeMilestoneName(input);
	if (!normalized) {
		return normalized;
	}

	const inputKey = milestoneKey(normalized);
	const looksLikeMilestoneId = /^\d+$/.test(normalized) || /^m-\d+$/i.test(normalized);
	const canonicalInputId = looksLikeMilestoneId
		? `m-${String(Number.parseInt(normalized.replace(/^m-/i, ""), 10))}`
		: null;

	const aliasKeys = new Set<string>([inputKey]);
	if (/^\d+$/.test(normalized)) {
		const numericAlias = String(Number.parseInt(normalized, 10));
		aliasKeys.add(numericAlias);
		aliasKeys.add(`m-${numericAlias}`);
	} else {
		const idMatch = normalized.match(/^m-(\d+)$/i);
		if (idMatch?.[1]) {
			const numericAlias = String(Number.parseInt(idMatch[1], 10));
			aliasKeys.add(numericAlias);
			aliasKeys.add(`m-${numericAlias}`);
		}
	}

	const idMatchesAlias = (milestoneId: string): boolean => {
		const idKey = milestoneKey(milestoneId);
		if (aliasKeys.has(idKey)) {
			return true;
		}
		if (/^\d+$/.test(milestoneId.trim())) {
			const numericAlias = String(Number.parseInt(milestoneId.trim(), 10));
			return aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`);
		}
		const idMatch = milestoneId.trim().match(/^m-(\d+)$/i);
		if (!idMatch?.[1]) {
			return false;
		}
		const numericAlias = String(Number.parseInt(idMatch[1], 10));
		return aliasKeys.has(numericAlias) || aliasKeys.has(`m-${numericAlias}`);
	};

	const findIdMatch = (milestones: Milestone[]): Milestone | undefined => {
		const rawExactMatch = milestones.find((item) => milestoneKey(item.id) === inputKey);
		if (rawExactMatch) {
			return rawExactMatch;
		}
		if (canonicalInputId) {
			const canonicalRawMatch = milestones.find((item) => milestoneKey(item.id) === canonicalInputId);
			if (canonicalRawMatch) {
				return canonicalRawMatch;
			}
		}
		return milestones.find((item) => idMatchesAlias(item.id));
	};

	const findUniqueTitleMatch = (milestones: Milestone[]): Milestone | null => {
		const titleMatches = milestones.filter((item) => milestoneKey(item.title) === inputKey);
		if (titleMatches.length === 1) {
			return titleMatches[0] ?? null;
		}
		return null;
	};

	const resolveByAlias = (milestones: Milestone[]): string | null => {
		const idMatch = findIdMatch(milestones);
		const titleMatch = findUniqueTitleMatch(milestones);
		if (looksLikeMilestoneId) {
			return idMatch?.id ?? null;
		}
		if (titleMatch) {
			return titleMatch.id;
		}
		if (idMatch) {
			return idMatch.id;
		}
		return null;
	};

	const activeTitleMatches = activeMilestones.filter((item) => milestoneKey(item.title) === inputKey);
	const hasAmbiguousActiveTitle = activeTitleMatches.length > 1;

	if (looksLikeMilestoneId) {
		const activeIdMatch = findIdMatch(activeMilestones);
		if (activeIdMatch) {
			return activeIdMatch.id;
		}
		const archivedIdMatch = findIdMatch(archivedMilestones);
		if (archivedIdMatch) {
			return archivedIdMatch.id;
		}
		if (activeTitleMatches.length === 1) {
			return activeTitleMatches[0]?.id ?? normalized;
		}
		if (hasAmbiguousActiveTitle) {
			return normalized;
		}
		const archivedTitleMatch = findUniqueTitleMatch(archivedMilestones);
		return archivedTitleMatch?.id ?? normalized;
	}

	const activeMatch = resolveByAlias(activeMilestones);
	if (activeMatch) {
		return activeMatch;
	}
	if (hasAmbiguousActiveTitle) {
		return normalized;
	}

	return resolveByAlias(archivedMilestones) ?? normalized;
}
```

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
git add src/core/milestones.ts
git commit -m "Add resolveMilestoneInput to core/milestones for shared milestone resolution"
```

---

## Task 3: Re-export new functions from `web/utils/milestones.ts`

The web components import milestone utilities from `web/utils/milestones.ts` which re-exports from core. Add the newly exported functions.

**Files:**
- Modify: `src/web/utils/milestones.ts`

**Step 1: Add re-exports**

Replace the current exports with:
```typescript
/**
 * Re-export milestone utilities from core for backward compatibility
 * All business logic lives in src/core/milestones.ts
 */
export {
	buildMilestoneAliasMap,
	buildMilestoneBuckets,
	buildMilestoneSummary,
	canonicalizeMilestoneValue,
	collectArchivedMilestoneKeys,
	collectMilestoneIds,
	getMilestoneLabel,
	isDoneStatus,
	milestoneKey,
	normalizeMilestoneName,
	resolveMilestoneInput,
	validateMilestoneName,
} from "../../core/milestones.ts";

// Re-export types from core types
export type { MilestoneBucket, MilestoneSummary } from "../../types/index.ts";
```

**Step 2: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/web/utils/milestones.ts
git commit -m "Re-export buildMilestoneAliasMap, canonicalizeMilestoneValue, resolveMilestoneInput from web utils"
```

---

## Task 4: Replace `server/index.ts` private `resolveMilestoneInput`

Delete the 120-line private method and import from core.

**Files:**
- Modify: `src/server/index.ts`

**Step 1: Add import**

At the top of `src/server/index.ts`, add:
```typescript
import { resolveMilestoneInput } from "../core/milestones.ts";
```

**Step 2: Delete the private method**

Remove the entire `private async resolveMilestoneInput` method (lines 98-218).

**Step 3: Update call sites**

The method was called as `this.resolveMilestoneInput(milestone)`. Since the old method loaded milestones internally, the callers need to be updated to load milestones first and pass them.

Find all call sites (likely in `handleCreateTask` and `handleUpdateTask`). Replace:
```typescript
const resolvedMilestone = await this.resolveMilestoneInput(milestone);
```
with:
```typescript
const [activeMilestones, archivedMilestones] = await Promise.all([
	this.core.filesystem.listMilestones(),
	this.core.filesystem.listArchivedMilestones(),
]);
const resolvedMilestone = resolveMilestoneInput(milestone, activeMilestones, archivedMilestones);
```

If milestones are already loaded in the same handler, reuse the existing variables instead of loading again.

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "Replace server resolveMilestoneInput with shared core function"
```

---

## Task 5: Replace `mcp/tools/tasks/handlers.ts` private `resolveMilestoneInput`

Same approach as Task 4.

**Files:**
- Modify: `src/mcp/tools/tasks/handlers.ts`

**Step 1: Add import**

```typescript
import { resolveMilestoneInput } from "../../../core/milestones.ts";
```

**Step 2: Delete private method**

Remove `private async resolveMilestoneInput` (lines 55-159).

**Step 3: Update call sites**

Replace `this.resolveMilestoneInput(milestone)` with:
```typescript
const [activeMilestones, archivedMilestones] = await Promise.all([
	this.core.filesystem.listMilestones(),
	this.core.filesystem.listArchivedMilestones(),
]);
const resolved = resolveMilestoneInput(milestone, activeMilestones, archivedMilestones);
```

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/mcp/tools/tasks/handlers.ts
git commit -m "Replace MCP task handler resolveMilestoneInput with shared core function"
```

---

## Task 6: Replace `mcp/tools/milestones/handlers.ts` duplicate functions

This file has `resolveMilestoneValueForReporting` (lines 109-195) which duplicates the resolution logic.

**Files:**
- Modify: `src/mcp/tools/milestones/handlers.ts`

**Step 1: Add import**

```typescript
import { resolveMilestoneInput } from "../../../core/milestones.ts";
```

(Note: `collectArchivedMilestoneKeys`, `milestoneKey`, `normalizeMilestoneName` are already imported via `../../utils/milestone-resolution.ts`)

**Step 2: Replace `resolveMilestoneValueForReporting` with `resolveMilestoneInput`**

Delete the `resolveMilestoneValueForReporting` function (lines 109-195). At each call site, replace:
```typescript
resolveMilestoneValueForReporting(value, activeMilestones, archivedMilestones)
```
with:
```typescript
resolveMilestoneInput(value, activeMilestones, archivedMilestones)
```

The behavior is identical - both resolve a milestone input considering active and archived milestones.

**Step 3: Keep `findActiveMilestoneByAlias` and `buildTaskMatchKeysForMilestone`**

These functions serve a different purpose (finding milestone objects, building match keys for task filtering) and use `resolveMilestoneStorageValue` from the shared MCP utils. They should stay as-is since they have a different responsibility.

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/mcp/tools/milestones/handlers.ts
git commit -m "Replace resolveMilestoneValueForReporting with shared resolveMilestoneInput"
```

---

## Task 7: Replace `commands/board.ts` inline `resolveMilestoneAlias`

The board command has a ~80-line inline `resolveMilestoneAlias` function (lines 50-131).

**Files:**
- Modify: `src/commands/board.ts`

**Step 1: Add import**

```typescript
import { resolveMilestoneInput } from "../core/milestones.ts";
```

(Note: `collectArchivedMilestoneKeys` and `milestoneKey` are already imported from `../core/milestones.ts`)

**Step 2: Delete inline function and replace usage**

Delete the entire `resolveMilestoneAlias` function (lines 50-131). At the call site where it's used to normalize task milestones, replace:
```typescript
const key = milestoneKey(resolveMilestoneAlias(task.milestone));
```
with:
```typescript
const key = milestoneKey(resolveMilestoneInput(task.milestone ?? "", milestoneEntities, archivedMilestones));
```

The `milestoneEntities` and `archivedMilestones` variables are already loaded in the same scope (line 43-49).

**Step 3: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/commands/board.ts
git commit -m "Replace board command inline resolveMilestoneAlias with shared core function"
```

---

## Task 8: Replace `web/lib/lanes.ts` duplicate `buildMilestoneAliasMap`

This file has a full copy of `buildMilestoneAliasMap` (lines 21-130) and `canonicalizeMilestone` (lines 132+).

**Files:**
- Modify: `src/web/lib/lanes.ts`

**Step 1: Replace imports**

Change:
```typescript
import { getMilestoneLabel, milestoneKey, normalizeMilestoneName } from "../utils/milestones";
```
to:
```typescript
import { buildMilestoneAliasMap, canonicalizeMilestoneValue, getMilestoneLabel, milestoneKey } from "../utils/milestones";
```

**Step 2: Delete local `buildMilestoneAliasMap`**

Delete the entire local `buildMilestoneAliasMap` function (lines 21-130).

**Step 3: Delete local `canonicalizeMilestone`**

Delete the local `canonicalizeMilestone` function. Replace all calls to `canonicalizeMilestone(value, aliasMap)` with `canonicalizeMilestoneValue(value, aliasMap)`.

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/web/lib/lanes.ts
git commit -m "Replace lanes.ts milestone duplication with shared core imports"
```

---

## Task 9: Replace `web/App.tsx` duplicate `buildMilestoneAliasMap`

**Files:**
- Modify: `src/web/App.tsx`

**Step 1: Add imports**

Change the milestone imports to include `buildMilestoneAliasMap` and `canonicalizeMilestoneValue`:
```typescript
import { buildMilestoneAliasMap, canonicalizeMilestoneValue, collectArchivedMilestoneKeys, collectMilestoneIds, milestoneKey } from './utils/milestones';
```

**Step 2: Delete local `buildMilestoneAliasMap`**

Delete the entire local function (lines 34-100+) and any local `canonicalizeMilestone` function.

**Step 3: Update call sites**

Replace any calls to the deleted local function with the imported version. Rename `canonicalizeMilestone(...)` to `canonicalizeMilestoneValue(...)` where needed.

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/web/App.tsx
git commit -m "Replace App.tsx milestone duplication with shared core imports"
```

---

## Task 10: Replace `web/components/Board.tsx` inline `milestoneAliasToCanonical`

The Board component has a ~110 line `useMemo` block (lines 53-163) that rebuilds the alias map inline.

**Files:**
- Modify: `src/web/components/Board.tsx`

**Step 1: Add imports**

```typescript
import { buildMilestoneAliasMap, canonicalizeMilestoneValue, collectArchivedMilestoneKeys, milestoneKey } from '../utils/milestones';
```

**Step 2: Replace the useMemo block**

Replace the entire `milestoneAliasToCanonical` useMemo (lines 53-163) with:
```typescript
const milestoneAliasToCanonical = useMemo(
  () => buildMilestoneAliasMap(milestoneEntities, archivedMilestones),
  [milestoneEntities, archivedMilestones]
);
```

**Step 3: Replace the local `canonicalizeMilestone` function**

Replace the local `canonicalizeMilestone` function (line 164+) with:
```typescript
const canonicalizeMilestone = (value?: string | null): string => {
  return canonicalizeMilestoneValue(value ?? null, milestoneAliasToCanonical);
};
```

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/web/components/Board.tsx
git commit -m "Replace Board.tsx inline milestone alias map with shared core function"
```

---

## Task 11: Replace `web/components/TaskList.tsx` inline `milestoneAliasToCanonical`

Same pattern as Board.tsx - has ~107 line useMemo block (lines 77-185).

**Files:**
- Modify: `src/web/components/TaskList.tsx`

**Step 1: Add imports**

```typescript
import { buildMilestoneAliasMap, canonicalizeMilestoneValue, collectArchivedMilestoneKeys, getMilestoneLabel, milestoneKey } from '../utils/milestones';
```

**Step 2: Replace useMemo block**

Replace the entire `milestoneAliasToCanonical` useMemo (lines 77-185) with:
```typescript
const milestoneAliasToCanonical = useMemo(
  () => buildMilestoneAliasMap(milestoneEntities ?? [], archivedMilestones ?? []),
  [milestoneEntities, archivedMilestones]
);
```

**Step 3: Replace local `canonicalizeMilestone`**

Replace with:
```typescript
const canonicalizeMilestone = (value?: string | null): string => {
  return canonicalizeMilestoneValue(value ?? null, milestoneAliasToCanonical);
};
```

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/web/components/TaskList.tsx
git commit -m "Replace TaskList.tsx inline milestone alias map with shared core function"
```

---

## Task 12: Replace `web/components/TaskDetailsModal.tsx` inline `resolveMilestoneToId`

This component has a ~76-line `useCallback` (lines 87-163) implementing `resolveMilestoneToId` and another ~40-line `resolveMilestoneLabel`.

**Files:**
- Modify: `src/web/components/TaskDetailsModal.tsx`

**Step 1: Add imports**

```typescript
import { resolveMilestoneInput, getMilestoneLabel } from '../utils/milestones';
```

(Check if `getMilestoneLabel` is already imported)

**Step 2: Replace `resolveMilestoneToId`**

Replace the entire `useCallback` (lines 87-163) with:
```typescript
const resolveMilestoneToId = useCallback((value?: string | null): string => {
  const normalized = (value ?? "").trim();
  if (!normalized) return "";
  return resolveMilestoneInput(normalized, milestoneEntities ?? [], archivedMilestoneEntities ?? []);
}, [milestoneEntities, archivedMilestoneEntities]);
```

**Step 3: Replace `resolveMilestoneLabel`**

Replace the inline label resolution with:
```typescript
const resolveMilestoneLabel = useCallback((value?: string | null): string => {
  const resolved = resolveMilestoneToId(value);
  if (!resolved) return "";
  return getMilestoneLabel(resolved, milestoneEntities ?? []);
}, [resolveMilestoneToId, milestoneEntities]);
```

(Verify this matches the existing behavior - the old function resolved to an ID then looked up the title.)

**Step 4: Run tests and type check**

```bash
CLAUDECODE=1 bun test --timeout 180000 && bunx tsc --noEmit
```

**Step 5: Commit**

```bash
git add src/web/components/TaskDetailsModal.tsx
git commit -m "Replace TaskDetailsModal inline milestone resolution with shared core functions"
```

---

## Task 13: Final verification and lint

**Step 1: Run full test suite**

```bash
CLAUDECODE=1 bun test --timeout 180000
```

Expected: All tests pass.

**Step 2: Type check**

```bash
bunx tsc --noEmit
```

Expected: No errors.

**Step 3: Lint check**

```bash
bun run check .
```

Expected: No errors.

**Step 4: Verify no remaining duplicates**

Search for any remaining inline milestone resolution patterns:

```bash
grep -rn "resolveMilestoneAlias\|resolveMilestoneInput\|resolveMilestoneToId\|resolveMilestoneValueForReporting\|buildMilestoneAliasMap" src/ --include="*.ts" --include="*.tsx" | grep -v "core/milestones\|web/utils/milestones\|mcp/utils/milestone-resolution\|\.test\." | grep -v "import "
```

Expected: Only function definitions in `core/milestones.ts` and re-exports in `web/utils/milestones.ts` and `mcp/utils/milestone-resolution.ts`.

**Step 5: Commit any final cleanup**

```bash
git add -A
git commit -m "Phase 1 complete: milestone resolution consolidated to core/milestones.ts"
```

---

## Summary

| Task | File | Lines Removed | Change |
|------|------|---------------|--------|
| 1 | core/milestones.ts | 0 | Export existing private functions |
| 2 | core/milestones.ts | 0 (adds ~110) | Add `resolveMilestoneInput` |
| 3 | web/utils/milestones.ts | 0 | Add re-exports |
| 4 | server/index.ts | ~120 | Delete private method |
| 5 | mcp/tools/tasks/handlers.ts | ~105 | Delete private method |
| 6 | mcp/tools/milestones/handlers.ts | ~87 | Delete `resolveMilestoneValueForReporting` |
| 7 | commands/board.ts | ~80 | Delete inline function |
| 8 | web/lib/lanes.ts | ~120 | Delete duplicate functions |
| 9 | web/App.tsx | ~70 | Delete local `buildMilestoneAliasMap` |
| 10 | web/components/Board.tsx | ~115 | Delete inline useMemo |
| 11 | web/components/TaskList.tsx | ~110 | Delete inline useMemo |
| 12 | web/components/TaskDetailsModal.tsx | ~115 | Delete inline useCallbacks |
| 13 | (verification) | 0 | Final verification |

**Net result:** ~920 lines of duplicated logic removed. One canonical source of truth in `core/milestones.ts`.

**Critical notes for the implementing engineer:**
- Always run tests after each task. If tests fail, STOP and investigate before proceeding.
- The `resolveMilestoneInput` in core is **synchronous** - callers must load milestones first.
- Web components import from `web/utils/milestones.ts`, not directly from `core/milestones.ts`.
- Server and MCP files import directly from `core/milestones.ts`.
- The `mcp/utils/milestone-resolution.ts` file has its OWN functions (`resolveMilestoneStorageValue`, `buildMilestoneMatchKeys`, `keySetsIntersect`) that are NOT duplicates - they serve a different purpose (MCP-specific matching). Leave those as-is.
