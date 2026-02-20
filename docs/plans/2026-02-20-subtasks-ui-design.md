# Subtasks UI Design

**Date:** 2026-02-20

## Overview

Add a "Subtasks" section to `TaskDetailsModal` that lists existing subtasks and allows creating new ones. The section appears in the main body, below the Description section.

## Visual Layout

```
── Subtasks ──────────────────────────────── [+ Add]

  TASK-1.1   Implement login form         In Progress
  TASK-1.2   Write unit tests             To Do
  TASK-1.3   Code review                  Done
  TASK-1.4   Deploy to staging            To Do
  TASK-1.5   Update docs                  To Do
  ── scrollable if more than 5 ──────────────────────
  TASK-1.6   Post-deploy check            To Do
```

- Max visible height = 5 rows; overflow scrolls vertically
- Each row: ID (monospace, muted) | Title (truncated) | Status badge (colored)
- Each row is clickeable → opens that subtask in the same modal
- `+ Add` button → opens `TaskDetailsModal` in create mode with `parentTaskId` pre-set

## Data Fetching

- Condition: only shown for tasks where `subtaskSummaries?.length > 0` OR when a subtask is created
- Fetch: `GET /api/tasks?parent=<taskId>` when the modal opens for a task with subtask summaries
- The API already supports this endpoint; returns full `Task[]` with status included
- No backend changes required

## Component Changes

### `TaskDetailsModal.tsx`

1. Add local state: `subtasks: Task[]`
2. On open (when `task` prop is set and `task.subtaskSummaries?.length > 0`): fetch subtasks via `api.fetchTasks({ parent: task.id })`
3. Render "Subtasks" section between Description and References
4. Section header: label "Subtasks" + `+ Add` button (same style as other action buttons in the modal)
5. Subtask list: max-height for 5 rows, `overflow-y: auto`
6. Each row: `task.id` | `task.title` | status badge
7. Row click: opens the subtask in the same modal (reuse existing task-open handler)
8. `+ Add` click: opens modal in create mode, passes `parentTaskId: task.id` in the submit payload

## What Does NOT Change

- Backend: no changes to server routes, task-lifecycle, or types
- `api.ts`: `fetchTasks({ parent })` already exists and works
- `TaskDetailsModal` create mode logic: unchanged, just receives `parentTaskId` in the payload
- Task list view: no subtask display in the list (out of scope)
