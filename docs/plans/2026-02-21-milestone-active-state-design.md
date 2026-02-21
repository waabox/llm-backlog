# Milestone Active State Design

**Date:** 2026-02-21

## Problem

All non-archived milestones currently appear in the Kanban board. There is no way to have a milestone
that exists (e.g. "General Backlog") but is not shown in the Kanban view. Users need to control which
milestones are actively being worked on.

## Decision

Add an explicit `active` boolean field to milestone frontmatter. Default is `false` on creation.
Only active milestones appear in the Kanban board. All milestones appear in the Milestones view.

## Data Model Change

### Milestone type (`src/types/index.ts`)

```typescript
export interface Milestone {
  id: string;
  title: string;
  description: string;
  active: boolean;       // NEW: whether this milestone shows in the Kanban board
  readonly rawContent: string;
}
```

### Milestone file frontmatter

```yaml
---
id: m-0
title: "General Backlog"
active: false
---
```

- New milestones always created with `active: false`
- Existing milestone files without the `active` field are parsed as `active: false` (backwards compatible)

## Component Changes

### Parser (`src/markdown/parser.ts`)
- `parseMilestone()` reads `active` from frontmatter
- If field is absent, defaults to `false`

### MilestoneStore (`src/file-system/milestone-store.ts`)
- `createMilestone()` writes `active: false` in frontmatter
- `serializeMilestoneContent()` includes the `active` field

### Kanban board (`src/board.ts`)
- `generateMilestoneGroupedBoard()` filters out milestones where `active !== true`
- "No Milestone" section always appears regardless

### MCP milestone_edit tool (`src/mcp/tools/milestones/`)
- Add optional `active: boolean` parameter to the edit schema

### CLI
- Add `set-active` / `set-inactive` subcommands under `milestone`
- Or a toggle: `backlog milestone toggle-active <id>`

### Web UI (`src/web/`)
- Milestones list shows all milestones with an active/inactive badge
- No filtering on the Milestones page

## Out of Scope
- Archived milestones: existing archive behavior unchanged
- Auto-activation based on task state
