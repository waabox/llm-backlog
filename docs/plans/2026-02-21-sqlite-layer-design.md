# SQLite Coordination Layer Design

**Date**: 2026-02-21
**Status**: Approved

## Problem

With 20+ concurrent users, the current filesystem-only architecture has two concrete race conditions:

1. **ID generation**: `generateNextId()` scans all files and takes the next number. Two simultaneous requests both read "TASK-41" and both create `TASK-42`.
2. **Last-write-wins**: No locking between `Bun.write()` and `git add`. Concurrent edits to the same task silently overwrite each other.

Additionally, listing and searching tasks requires scanning and parsing all markdown files on every request.

## Solution

Add SQLite (via Bun's native SQLite support) as a coordination layer on top of the existing filesystem. Markdown files remain the source of truth for content and git history. SQLite handles ID sequencing, write serialization, and fast indexing.

Database file: `backlog/llm-backlog.db` (gitignored).

## Architecture

```
Core → StorageCoordinator → FileSystem      (markdown read/write)
                          → SqliteCoordinator (IDs, index, search)
Core → GitOperations (unchanged)
```

`Core` replaces its `FileSystem` dependency with `StorageCoordinator`. The coordinator exposes the same interface as `FileSystem` plus new methods (`generateNextId`, `searchTasks`, `sync`). Core is unaware of SQLite.

## Schema

### `sequences`
Atomic ID generation per entity type.

```sql
CREATE TABLE sequences (
  entity_type TEXT PRIMARY KEY,  -- 'task', 'draft', 'milestone', 'decision', 'doc'
  prefix      TEXT NOT NULL,     -- 'TASK', 'DRAFT', 'M', 'DEC'
  current_val INTEGER NOT NULL DEFAULT 0
);
```

### `task_index`
Replaces the in-memory ContentStore. Enables O(1) listing and filtering without file scans.

```sql
CREATE TABLE task_index (
  id           TEXT PRIMARY KEY,
  entity_type  TEXT NOT NULL,   -- 'task', 'draft', 'completed', 'archived'
  title        TEXT,
  status       TEXT,
  assignee     TEXT,            -- JSON array
  labels       TEXT,            -- JSON array
  milestone    TEXT,
  priority     TEXT,
  parent_id    TEXT,
  file_path    TEXT NOT NULL,
  body         TEXT,            -- full markdown content for FTS
  updated_date TEXT
);
```

### `fts_tasks`
FTS5 virtual table for full-text search over title and body.

```sql
CREATE VIRTUAL TABLE fts_tasks USING fts5(
  id, title, body,
  content='task_index'
);
```

## Data Flows

### ID Generation
```
storageCoordinator.generateNextId('task')
  → BEGIN IMMEDIATE
  → UPDATE sequences SET current_val = current_val + 1 WHERE entity_type = 'task'
  → SELECT current_val
  → COMMIT
  → return "TASK-{val}"
```
SQLite's `BEGIN IMMEDIATE` serializes concurrent writers. Two simultaneous ID requests always produce distinct IDs.

### Write
```
storageCoordinator.saveTask(task)
  → fileSystem.saveTask(task)       -- write markdown to disk
  → sqlite.upsert(task_index, task) -- update index
  → return filepath
```
SQLite WAL mode serializes concurrent writes natively. No explicit lock table needed.

### List / Filter
```
storageCoordinator.listTasks(filter)
  → sqlite.query(task_index, filter)  -- indexed query, no file scan
  → return tasks[]
```

### Search
```
storageCoordinator.searchTasks(query)
  → sqlite.query(fts_tasks, query)    -- FTS5
  → return tasks[]
```

### Sync (explicit command)
```
backlog sync
  → scan all .md files in backlog/
  → parse each markdown file
  → BEGIN TRANSACTION
  → DELETE FROM task_index; re-insert all
  → recalculate sequences (SELECT MAX id per entity_type)
  → COMMIT
  → print "Synced 247 tasks, 12 drafts"
```
Idempotent. Can be run any number of times.

### Startup
`StorageCoordinator` constructor checks if `backlog/llm-backlog.db` exists:
- Exists → use SQLite directly
- Does not exist → create schema + run sync automatically from existing markdowns

## New Files

```
src/
  file-system/
    sqlite-coordinator.ts   -- owns SQLite connection, schema, queries
    storage-coordinator.ts  -- facade: owns FileSystem + SqliteCoordinator
```

## Changed Files

```
src/
  core/
    backlog.ts              -- FileSystem → StorageCoordinator; generateNextId delegates to fs
    task-lifecycle.ts       -- generateNextId call updated
  main.ts                   -- new `sync` CLI command
```

## Out of Scope

- ContentStore watchers: remain as-is for now, can be deprecated in a follow-up
- Milestones, decisions, docs: only tasks and drafts are indexed in this iteration
- Conflict detection on concurrent edits: not needed for this use case
