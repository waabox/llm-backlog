# Inactive Milestone Task Filtering

**Date:** 2026-02-21
**Status:** Approved

## Problem

Tasks assigned to an inactive milestone currently appear in the Kanban board and MCP task list. Only the milestone *lanes/sections* are hidden — the tasks themselves bleed through into other views. Users want tasks belonging to inactive milestones to be invisible everywhere until the milestone is reactivated.

## Approach

Filter at the query layer (`queryTasks()` in `src/core/task-query.ts`). Every task listing call loads milestones, builds a set of inactive milestone keys, and strips tasks whose `milestone` field matches. This keeps the logic in one place and avoids duplicating it across consumers.

## Design

### Core layer — `src/core/task-query.ts`

- Add `excludeInactiveMilestones?: boolean` to `QueryTasksArgs`
- When true: load all milestones, collect inactive ones into a `Set<string>` of normalized keys, filter out tasks whose `milestone` matches any inactive key
- Use `normalizeMilestoneName()` from `src/core/milestones.ts` for consistent key matching

### MCP — `src/mcp/tools/tasks/handlers.ts`

- Pass `excludeInactiveMilestones: true` to `queryTasks()` in `listTasks()`
- No visible API surface change — tasks with inactive milestones simply stop appearing

### CLI board — `src/board.ts`

- Pass `excludeInactiveMilestones: true` to the task load in `generateMilestoneGroupedBoard()`
- The existing active-milestone lane filter is kept as-is; task-level filtering is added on top

### Web board REST route

- Find the REST endpoint that serves tasks for the board
- Apply `excludeInactiveMilestones: true` so tasks with inactive milestones cannot bleed into unassigned or other lanes

## Invariants

- `task_view` is unaffected — direct task lookup always works regardless of milestone state
- The `active` default on milestones remains `true` for backward compatibility (no existing tasks are affected)
- Milestone normalization is handled by the existing `normalizeMilestoneName()` utility

## Out of Scope

- No new MCP parameter to toggle this behavior — it is always-on
- No changes to how milestones are displayed or listed
- No changes to `task_complete`, `task_archive`, or `task_edit` — those operations work on tasks regardless of milestone state
