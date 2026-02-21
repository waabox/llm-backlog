# Backlog.md Task Management

## When to Create Tasks

Create or find a task when work requires planning or decisions. Skip for trivial changes, questions, or exploration.

## Working on a Task

1. **Find:** `backlog task list --plain` or `backlog search "topic" --plain`
2. **Ask user:** what status to set → `backlog task edit 42 -s "In Progress" -a @you`
3. **Read:** `backlog task 42 --plain`
4. **Plan:** draft approach, present to user, wait for explicit approval
5. **Record:** `backlog task edit 42 --plan $'1. Step\n2. Step'` — do not code before this
6. **Implement:** code, test, verify
7. **Finish:** `backlog task edit 42 --final-summary "..."` then ask user what status (usually "Done")

If the task has subtasks → ask user which to tackle first.
If scope changes → stop and ask before proceeding.

## Creating Tasks

- Title: brief outcome, no implementation details
- Description: why + what, enough context for an independent developer to start
- `backlog task create "Title" -d "Description"`

## Key Rules

- **Never edit .md files directly** — always use CLI commands
- Use `$'Line1\nLine2'` (ANSI-C quoting) for multi-line plan/summary input
- `backlog task archive 42` — for canceled/duplicate tasks only, not completed work
