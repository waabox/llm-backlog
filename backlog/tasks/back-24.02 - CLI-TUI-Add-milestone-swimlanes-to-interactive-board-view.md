---
id: BACK-24.02
title: 'CLI TUI: Add milestone swimlanes to interactive board view'
status: In Progress
assignee: []
created_date: '2025-12-17 21:42'
updated_date: '2026-02-19 18:03'
labels:
  - cli
  - tui
  - enhancement
dependencies: []
parent_task_id: BACK-24
priority: low
ordinal: 3000
---

## Description

<!-- SECTION:DESCRIPTION:BEGIN -->
The `-m/--milestones` flag for `backlog board` only works in non-TTY mode (markdown output). The interactive TUI board ignores the flag entirely.

Implement milestone swimlanes in the TUI board view to match the web UI's milestone view behavior - grouping tasks by milestone with collapsible sections.
<!-- SECTION:DESCRIPTION:END -->
