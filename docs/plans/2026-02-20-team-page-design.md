# Team Page Design

**Date:** 2026-02-20

## Goal

Add a new "Team" section to the web UI that lets any user browse tasks assigned to any team member. Tasks are grouped by milestone, each row shows status and a link to open the task detail modal. After closing the modal the user returns to the same team member view.

## Approach

New standalone page `TeamPage.tsx` at route `/team`. Reuses existing API endpoints and the `TaskDetailsModal` component. No backend changes.

## Routing

- `/team` — Team page, no member selected yet
- `/team?assignee=email@domain.com` — Team page filtered by a specific member
- `/team/:taskId?assignee=email@domain.com` — Task modal open, preserves assignee context

When the modal is closed, navigate back to `/team?assignee=...` keeping the selected member.

## UI Structure

### Sidebar
Add a "Team" nav item with the Lucide `Users` icon, positioned between "My Work" and "Milestones" in `SideNavigation.tsx`.

### TeamPage layout
1. **Header** — title "Team"
2. **User selector** — `<select>` dropdown populated from `GET /api/users`. Default option: "Select a team member". Changing the selection updates the `?assignee=` query param via `useNavigate`.
3. **Task list** — visible only when a member is selected. Tasks grouped by milestone (same structure as `MyWorkPage`). A "No Milestone" group collects unassigned tasks.
4. **Task row** — shows: task ID, title, status badge, clickable link that opens the modal.

## Data Flow

- Users list: `GET /api/users` — fetched once on mount, used to populate the dropdown.
- Tasks: `GET /api/tasks` — already fetched at app level in `App.tsx` and passed down. Filtered client-side by assignee using the same logic as `MyWorkPage` (string includes match on `"Name <email>"` entries).

## Modal Behaviour

`TeamPage` registers a nested route `/team/:taskId`. When a task link is clicked it navigates to `/team/:taskId?assignee=...`. `TaskDetailsModal` opens. On close, navigate to `/team?assignee=...`. The assignee query param is threaded through so the view is preserved.

## Files Changed

| File | Change |
|------|--------|
| `src/web/App.tsx` | Add `/team` and `/team/:taskId` routes |
| `src/web/SideNavigation.tsx` | Add "Team" nav item |
| `src/web/TeamPage.tsx` | New component |

## What Does Not Change

- No new backend endpoints
- `MyWorkPage` untouched
- `config.yml` untouched
- `TaskDetailsModal` untouched
