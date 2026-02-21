## llm-backlog Workflow

**Project statuses:** {{STATUSES}}

### When to Use Backlog

Create or find a task when work requires planning or decisions. Skip for trivial changes, questions, or exploration.

### Working on a Task

1. **Find:** `task_search` or `task_list` with status/label filters (never list all tasks)
2. **Ask user:** which status to set when starting work → `task_edit` with that status + assignee
3. **Read:** `task_view` to understand description and context
4. **Plan:** draft implementation approach, present to user, wait for explicit approval
5. **Record:** `task_edit` with `planSet` after approval — do not code before this
6. **Implement:** code, test, verify
7. **Finish:** `task_edit` with `finalSummary` (PR-style: what changed, why, tests run), then ask user which status to set

If the task has subtasks → present the list, ask user which to tackle first.
If scope changes mid-work → stop and ask before proceeding.
Never create new tasks autonomously.

### Creating Tasks

- **Title:** brief outcome, no implementation details
- **Description:** why + what, enough context for an independent agent to start with no prior knowledge
- **Scope:** atomic (single PR); multi-PR work → subtasks or separate tasks with `--dep` dependencies
- Attach relevant files/specs via `references` and `documentation` fields
- Always search first to avoid duplicates

### MCP Tools

- `task_list` — list with status/assignee/label filters
- `task_search` — search by title/description
- `task_view` — read full task (description, plan, final summary)
- `task_create` — create task with title, description, labels, priority, assignee, references, documentation
- `task_edit` — update status, plan (`planSet`/`planAppend`), `finalSummary`, assignee, dependencies
- `task_archive` — canceled/duplicate/invalid tasks only (not for completed work)
- `task_complete` — batch cleanup of final-status tasks (not per-task workflow)
- `document_list`, `document_view`, `document_search` — read project docs

**Always use MCP tools. Never edit task markdown files directly.**
