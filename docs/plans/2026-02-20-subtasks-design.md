# Sub-tasks Design

**Date:** 2026-02-20

## Overview

Add sub-task support to backlog.md by changing the task storage structure from flat `.md` files to ID-named folders containing the task file.

## Directory Structure

```
backlog/
  tasks/
    TASK-1/
      TASK-1 - Title.md         ← parent task file (keeps title in filename)
      SubTasks/                 ← only created when first subtask added
        TASK-1.1 - Sub title.md
        TASK-1.2 - Sub title.md
    TASK-2/
      TASK-2 - Other title.md
  completed/
    TASK-3/
      TASK-3 - Done title.md
      SubTasks/
        TASK-3.1 - Sub.md
  drafts/
    DRAFT-1/
      DRAFT-1 - Draft title.md
  archive/
    tasks/
      TASK-4/
        TASK-4 - Archived title.md
```

### Key rules
- Folder name = task ID only (e.g., `TASK-1/`, never `TASK-1 - Title/`)
- The `.md` file inside keeps the full `ID - Title.md` naming convention
- `SubTasks/` directory is created lazily (only when the first subtask is added)
- Subtask IDs use dot notation: `TASK-1.1`, `TASK-1.2`
- Complete/archive operations move the entire folder

## Affected Components

### `src/utils/task-path.ts`
- `getTaskDir(taskId)` — new: returns path to the ID-named folder (e.g., `backlog/tasks/TASK-1/`)
- `getSubTasksDir(taskId)` — new: returns `backlog/tasks/TASK-1/SubTasks/`
- `getTaskPath()` — updated: resolves `.md` file inside the folder

### `src/file-system/task-store.ts`
- `createTask()` — creates `TASK-X/` folder, writes `.md` inside; if subtask, creates `SubTasks/` in parent folder
- `loadTask()` — reads from `TASK-X/TASK-X - Title.md`
- `listTasks()` — globs `*/` folders, finds `.md` inside each
- `moveTask()` (complete/archive) — moves entire `TASK-X/` folder

### `src/core/id-generation.ts`
- ID scanner reads inside `TASK-X/` folders instead of flat `.md` files
- Subtask creation: generates next `TASK-X.N` ID, ensures `SubTasks/` dir exists in parent

## CLI Usage

Creating a subtask:
```bash
backlog task create --parent TASK-1 "Subtask title"
```

## What Does NOT Change
- Task file content format (frontmatter + markdown body)
- `parentTaskId` / `subtasks` fields in frontmatter
- ID dot notation (`TASK-1.1`, `TASK-1.2`)
- Git auto-commit behavior
- MCP tool interface
