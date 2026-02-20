# Settings Page with Labels (and Full Config Editing) — Design

**Date:** 2026-02-20
**Status:** Approved

---

## Overview

Add a `/settings` page to the web UI that lets users view and edit the project's `config.yml`. The primary driver is Labels management (add/remove labels), but the page covers the full config for completeness. On save, the app commits and pushes changes to git automatically.

---

## Goals

- List labels from config and allow adding/removing them via the UI.
- Edit other config fields (statuses, project name, general settings).
- Save writes `config.yml`, commits with a standard message, and pushes to the remote.
- All open tabs receive a live update via WebSocket after save.

---

## Architecture

### Data flow

1. `SettingsPage` mounts → `GET /api/config` returns full `BacklogConfig`.
2. User edits fields in local component state (no API calls on each keystroke).
3. User clicks **Save & Push** → `PUT /api/config` with the full updated config.
4. Backend saves via `ConfigStore.saveConfig()`, runs `git commit` + `git push` via `GitOperations`.
5. Backend broadcasts `"config-updated"` over WebSocket.
6. All connected frontend clients reload config from the global context.

---

## Backend Changes

### `src/server/routes/config.ts`

Add `handleUpdateConfig(core, body: Partial<BacklogConfig>): Promise<Response>`:
- Load current config.
- Merge incoming fields into current config.
- Save via `core.filesystem.saveConfig(merged)`.
- Commit: `"chore(config): update project configuration"`.
- Push via existing `GitOperations`.
- Return updated config as JSON.

### `src/server/index.ts`

- Wire `PUT /api/config → handleUpdateConfig`.
- After save, call `this.broadcastConfigUpdated()`.

---

## Frontend Changes

### `src/web/components/SettingsPage.tsx` (new)

Tabbed layout with four tabs:

**General**
- Project name (text input)
- Default status (dropdown, populated from statuses list)
- Default assignee (text input)

**Labels**
- Current labels rendered as chips with `×` remove button.
- Text input + "Add" button to add a new label.
- "Save & Push" button.

**Statuses**
- Same chip pattern as Labels.
- "Save & Push" button.

**Advanced**
- `auto_commit` toggle
- `auto_open_browser` toggle
- `max_column_width` number input
- `active_branch_days` number input

Each tab has its own **Save & Push** button that sends only the full updated config (all fields) to `PUT /api/config`.

### `src/web/App.tsx`

Add route: `/settings → <SettingsPage />`

### `src/web/components/SideNavigation.tsx`

Add "Settings" link with gear icon in the navigation, pointing to `/settings`.

### `src/web/lib/api.ts`

Add method:
```typescript
async updateConfig(config: BacklogConfig): Promise<BacklogConfig>
```
Sends `PUT /api/config` with the full config body.

---

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/web/components/SettingsPage.tsx` | Create |
| `src/web/App.tsx` | Modify (add route) |
| `src/web/components/SideNavigation.tsx` | Modify (add nav link) |
| `src/web/lib/api.ts` | Modify (add updateConfig) |
| `src/server/routes/config.ts` | Modify (add handleUpdateConfig) |
| `src/server/index.ts` | Modify (wire PUT /api/config) |

---

## Out of Scope

- Per-tab save (single save sends full config).
- Undo/redo.
- Label colors.
- Config validation beyond type coercion.
