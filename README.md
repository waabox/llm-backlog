# Backlog.md

A web-based project backlog for humans and AI agents. Tasks live as plain Markdown files inside a Git repository. A web UI lets humans manage them visually; an MCP endpoint lets AI agents read, create, and update them programmatically.

---

## What is a backlog?

A backlog is an ordered list of work that needs to be done on a project. Each item in the backlog is called a **task**. Tasks are not calendar items — they have no fixed start date. They describe *what* needs to happen and *why*, and they sit in the backlog until someone picks them up.

The backlog is always changing. New tasks get added when ideas or bugs surface. Tasks get refined when more context becomes available. Tasks get closed when the work is done. The goal is to keep the list honest: every task should be clear enough that anyone — human or AI — can read it and understand exactly what is expected.

---

## What is a task?

A task is a Markdown file. It has a YAML frontmatter block with structured metadata and a body with freeform sections.

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

### Body sections

| Section | For whom | Purpose |
|---|---|---|
| **Description** | Human + AI | What needs to be done and why. Be specific. The better this is written, the better the AI output. |
| **Acceptance Criteria** | Human + AI | Concrete, checkable conditions that define "done". Each item is a checkbox. |
| **Definition of Done** | Human + AI | Project-wide quality checklist applied to every task (tests pass, docs updated, etc.). |
| **Implementation Plan** | AI | Written by the AI *before* coding. Describes the approach. A human reviews and approves it before the AI proceeds. |
| **Implementation Notes** | AI | Running notes the AI adds while working. Observations, decisions made, dead ends. |
| **Final Summary** | AI | Written by the AI when the task is complete. A PR-style summary of what changed and why. |

### A well-written task

The Description and Acceptance Criteria are the most important parts. They are the contract between the person who wants the work done and the person (or AI) doing it.

- **Description**: explain the problem and the desired outcome. Give enough context that someone who has never touched this codebase could understand what is being asked.
- **Acceptance Criteria**: list every condition that must be true before the task can be closed. Make each item verifiable — not "works correctly" but "clicking Save persists the record to the database and shows a success toast."

A task that is vague produces vague results. A task that is precise produces precise results.

---

## Running the server

```bash
# Copy and edit the environment file
cp run.sh.example run.sh   # set BACKLOG_PROJECT_REPO, AUTH_CONFIG_REPO, GOOGLE_CLIENT_ID
./run.sh
```

Or directly:

```bash
PORT=6420 OPEN_BROWSER=false bun src/main.ts
```

The server exposes:
- **Web UI** at `http://localhost:6420`
- **MCP endpoint** at `http://localhost:6420/mcp`

---

## Web UI

The web interface is the primary way for humans to interact with the backlog.

- **Board** — Kanban view, drag tasks between columns.
- **All Tasks** — table view with filtering by status, priority, and label.
- **Milestones** — group tasks by milestone and track progress.
- **Decisions** — log architectural decisions as ADRs.
- **Documents** — store reference documentation alongside the tasks.

Authentication uses Google OAuth. Configure `GOOGLE_CLIENT_ID` and `AUTH_CONFIG_REPO` in `run.sh`.

---

## For AI agents (MCP)

The MCP endpoint at `/mcp` implements the [Model Context Protocol](https://modelcontextprotocol.io). AI agents connect to it to read and manage the backlog without touching the filesystem directly.

### Connection

Add this to your agent's MCP config:

```json
{
  "mcpServers": {
    "backlog": {
      "url": "http://localhost:6420/mcp",
      "headers": { "Authorization": "Bearer <api-key>" }
    }
  }
}
```

API keys are defined in the `users.md` file inside the `AUTH_CONFIG_REPO` repository.

### Available tools

| Tool | What it does |
|---|---|
| `task_list` | List tasks, optionally filtered by status, assignee, labels, or a search query |
| `task_search` | Full-text fuzzy search across task titles and descriptions |
| `task_view` | Read the full content of a single task by ID |
| `task_create` | Create a new task with title, description, acceptance criteria, and other fields |
| `task_edit` | Update any field of an existing task, including appending to plan/notes/final summary |
| `task_complete` | Move a task to the completed folder |
| `task_archive` | Archive a task |

### Recommended agent workflow

This is the intended loop for AI-assisted development. It is designed to keep humans in control of what gets built and how.

**1. Decompose**

Ask the agent to break a feature or goal into small, independent tasks. Each task should be completable in a single conversation without running out of context.

**2. Refine**

Review the tasks the agent created. Read the descriptions and acceptance criteria. Edit them until they are precise enough that you would be satisfied if the agent delivered exactly what is written — nothing more, nothing less.

**3. Plan**

Assign one task to the agent. Before writing any code, ask it to research the codebase and write an implementation plan into the task (`planSet` field). Review the plan. If the approach looks wrong, reject it and ask for a revision. Approve only when the approach makes sense.

**4. Implement**

Once the plan is approved, let the agent implement the task. It should append notes as it works (`notesAppend`) and write a final summary when done (`finalSummary`).

**5. Review**

Read the code, run the tests. If the output does not match expectations, clear the plan and notes, refine the acceptance criteria, and start the task again in a fresh session.

### task_edit field reference

When editing a task, the following operations are available:

```
title, description, status, priority, milestone, labels, assignee, dependencies

# Plan
planSet          — replace the implementation plan
planAppend       — append lines to the plan
planClear        — delete the plan

# Notes
notesSet         — replace implementation notes
notesAppend      — append lines to notes
notesClear       — delete notes

# Final summary
finalSummary     — set the completion summary (write when task is done)
finalSummaryAppend
finalSummaryClear

# Acceptance criteria
acceptanceCriteriaSet    — replace all items
acceptanceCriteriaAdd    — add new items
acceptanceCriteriaCheck  — mark items checked by index
acceptanceCriteriaUncheck

# Definition of done
definitionOfDoneAdd
definitionOfDoneCheck
definitionOfDoneUncheck
definitionOfDoneRemove

# References and docs
references, addReferences, removeReferences
documentation, addDocumentation, removeDocumentation
```

---

## Storage

All data is plain text. Tasks, milestones, decisions, and documents are Markdown files committed to Git. The server auto-commits mutations when `auto_commit: true` is set in `backlog/config.yml`.

```
backlog/
  tasks/          ← active tasks
  tasks/archive/  ← archived tasks
  tasks/done/     ← completed tasks
  milestones/     ← milestone definitions
  decisions/      ← architectural decision records
  documents/      ← reference documentation
  config.yml      ← project configuration
```

---

## License

MIT
