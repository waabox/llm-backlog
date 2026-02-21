# llm-backlog

[![CI](https://github.com/waabox/llm-backlog/actions/workflows/ci.yml/badge.svg)](https://github.com/waabox/llm-backlog/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/llm-backlog)](https://www.npmjs.com/package/llm-backlog)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-black?logo=bun)](https://bun.sh)

A project backlog for humans and AI agents. Tasks live as plain Markdown files inside a Git repository. A web UI lets humans manage them visually; an MCP endpoint lets AI agents read, create, and update them programmatically.

---

## What is a backlog?

A backlog is an ordered list of work that needs to be done on a project. Each item is called a **task**. Tasks have no fixed start date — they describe *what* needs to happen and *why*, and they sit in the backlog until someone picks them up.

The backlog is always changing. New tasks get added when ideas or bugs surface. Tasks get refined as context accumulates. Tasks get closed when the work is done. The goal is to keep the list honest: every task should be clear enough that anyone — human or AI — can read it and know exactly what is expected.

---

## What is a task?

A task is a Markdown file with a YAML frontmatter block and a freeform body.

```
backlog/tasks/back-42 - Add payment webhook handler.md
```

### Metadata (frontmatter)

| Field | Purpose |
|---|---|
| `id` | Unique identifier, e.g. `BACK-42` |
| `title` | One-line summary of the work |
| `status` | Current state: `To Do`, `In Progress`, `Review`, `Done`, `Blocked` |
| `priority` | `high`, `medium`, or `low` |
| `assignee` | Who is doing this, e.g. `@alice` |
| `milestone` | Which milestone this task belongs to |
| `labels` | Free tags for filtering |
| `dependencies` | IDs of tasks that must finish first |
| `references` | URLs or file paths relevant to the task |
| `documentation` | Additional documentation URLs or paths |

### Body sections

| Section | For whom | Purpose |
|---|---|---|
| **Description** | Human + AI | What needs to be done and why. The better this is written, the better the AI output. |
| **Implementation Plan** | AI | Written by the AI before coding. Describes the approach. Review and approve before the AI proceeds. |
| **Final Summary** | AI | Written by the AI when the task is complete. A PR-style summary of what changed and why. |

### A well-written task

The description is the contract between the person who wants the work done and the person (or AI) doing it. Explain the problem and the desired outcome. Give enough context that someone unfamiliar with the codebase could understand what is being asked.

A vague task produces vague results. A precise task produces precise results.

---

## Running the server

```bash
# Install dependencies
bun i

# Start the server
PORT=6420 OPEN_BROWSER=false bun src/main.ts
```

The server exposes:
- **Web UI** at `http://localhost:6420`
- **MCP endpoint** at `http://localhost:6420/mcp`

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | No (default: `6420`) | Port to listen on |
| `BACKLOG_PROJECT_REPO` | No | Remote git repo to clone as the project root. Leave empty to use the current working directory. |
| `AUTH_CONFIG_REPO` | No | Remote git repo containing `users.md` for API key and OAuth auth. Required to enable authentication. |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID. Required for web UI login. |
| `JWT_SECRET` | No | JWT secret for session tokens. Auto-generated if empty. |
| `OPEN_BROWSER` | No (default: `true`) | Set to `false` to suppress the browser launch on start. |

---

## Web UI

The web interface is the primary way for humans to interact with the backlog.

- **Board** — Kanban view, drag tasks between columns.
- **All Tasks** — table view with filtering by status, priority, and label.
- **My Work** — tasks assigned to the logged-in user, grouped by milestone.
- **Milestones** — group tasks by milestone and track progress.
- **Decisions** — log architectural decisions as ADRs.
- **Documents** — store reference documentation alongside the tasks.

Authentication uses Google OAuth. Configure `GOOGLE_CLIENT_ID` and `AUTH_CONFIG_REPO` to enable it.

---

## Storage

All data is plain text. Tasks, milestones, decisions, and documents are Markdown files committed to Git. The server auto-commits mutations when `auto_commit: true` is set in `backlog/config.yml`.

```
backlog/
  tasks/              ← active tasks
  tasks/archive/      ← archived tasks
  tasks/done/         ← completed tasks
  milestones/         ← milestone definitions
  milestones/archive/ ← archived milestones
  decisions/          ← architectural decision records
  documents/          ← reference documentation
  config.yml          ← project configuration
```

---

## For AI agents (MCP)

The MCP endpoint at `/mcp` implements the [Model Context Protocol](https://modelcontextprotocol.io). AI agents connect to it to read and manage the backlog without touching the filesystem directly.

### Connection

Add this to your agent's MCP configuration:

```json
{
  "mcpServers": {
    "backlog": {
      "type": "http",
      "url": "http://localhost:6420/mcp?token=<your-api-key>"
    }
  }
}
```

The token is passed as a query parameter because some MCP clients (e.g. Claude Code) do not support custom headers in HTTP server configuration. API keys are defined in the `users.md` file inside the `AUTH_CONFIG_REPO` repository.

### Authentication and roles

Users are defined in `users.md` inside the config repo:

```yaml
---
users:
  - email: alice@example.com
    name: Alice
    role: admin
    apiKey: sk-alice-secret-key
  - email: bob@example.com
    name: Bob
    role: viewer
    apiKey: sk-bob-readonly-key
---
```

| Role | Access |
|---|---|
| `admin` | All tools: read and write |
| `viewer` | Read-only tools: `task_list`, `task_search`, `task_view`, `milestone_list`, `document_list`, `document_view`, `document_search`, `get_workflow_overview` |

### Available tools

#### Tasks

| Tool | What it does |
|---|---|
| `task_list` | List tasks, optionally filtered by status, assignee, labels, or a search query |
| `task_search` | Full-text fuzzy search across task titles and descriptions |
| `task_view` | Read the full content of a single task by ID |
| `task_create` | Create a new task |
| `task_edit` | Update any field of an existing task |
| `task_move` | Move a task to a status; auto-assigns the caller if not already an assignee |
| `task_take` | Assign a task to yourself |
| `task_archive` | Archive a task |
| `task_complete` | Move a task to the completed folder (task must be in Done status first) |

> `task_move` and `task_take` inject the authenticated user's identity automatically. They are only available over HTTP transport, not stdio.

#### Milestones

| Tool | What it does |
|---|---|
| `milestone_list` | List all milestones (active, archived, and task-only) |
| `milestone_add` | Create a new milestone |
| `milestone_rename` | Rename a milestone and update all tasks that reference it |
| `milestone_remove` | Remove a milestone, with options to clear, keep, or reassign task milestones |
| `milestone_archive` | Archive a milestone |

#### Documents

| Tool | What it does |
|---|---|
| `document_list` | List documents, with optional keyword filter |
| `document_view` | Read the full content of a document by ID |
| `document_create` | Create a new document |
| `document_update` | Update an existing document's content or title |
| `document_search` | Full-text fuzzy search across documents |

#### Workflow

| Tool | What it does |
|---|---|
| `get_workflow_overview` | Retrieve the llm-backlog workflow guide for the current project |

### task_edit field reference

```
title, description, status, priority, milestone, labels, assignee,
dependencies, references, addReferences, removeReferences,
documentation, addDocumentation, removeDocumentation

# Implementation plan
planSet          — replace the implementation plan
planAppend       — append lines to the plan
planClear        — delete the plan

# Final summary
finalSummary           — set the completion summary (write when task is done)
finalSummaryAppend     — append to the final summary
finalSummaryClear      — delete the final summary
```

### Recommended agent workflow

This is the intended loop for AI-assisted development. It keeps humans in control of what gets built and how.

**1. Decompose**

Ask the agent to break a feature or goal into small, independent tasks. Each task should be completable in a single conversation without running out of context.

**2. Refine**

Review the tasks the agent created. Edit descriptions and acceptance criteria until they are precise enough that you would be satisfied if the agent delivered exactly what is written — nothing more, nothing less.

**3. Plan**

Assign one task to the agent. Before writing any code, ask it to research the codebase and write an implementation plan into the task (`planSet`). Review the plan. If the approach looks wrong, reject it and ask for a revision. Approve only when the approach makes sense.

**4. Implement**

Once the plan is approved, let the agent implement the task. It should write a final summary when done (`finalSummary`).

**5. Review**

Read the code, run the tests. If the output does not match expectations, clear the plan, refine the acceptance criteria, and start the task again in a fresh session.

---

## License

MIT
