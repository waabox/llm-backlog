<!-- LLM-BACKLOG MCP GUIDELINES START -->

<CRITICAL_INSTRUCTION>

## BACKLOG WORKFLOW INSTRUCTIONS

This project uses llm-backlog MCP for all task and project management.

**CRITICAL RESOURCE**: Read `backlog://workflow/overview` to understand when and how to use Backlog for this project.

- **First time working here?** Read the overview resource IMMEDIATELY to learn the workflow
- **Already familiar?** You should have the overview cached ("## llm-backlog Overview (MCP)")
- **When to read it**: BEFORE creating tasks, or when you're unsure whether to track work

</CRITICAL_INSTRUCTION>

<!-- LLM-BACKLOG MCP GUIDELINES END -->

When working on a task, assign it yourself.

After implementation, simplify: you know more about the task now than when you started.

## Simplicity-first

- Prefer a single implementation for similar concerns. Reuse or refactor instead of duplicating.
- Keep APIs minimal. Don't add unused methods.
- Avoid extra layers unless immediately proven needed.
- Keep behavior consistent across similar stores. Divergence requires a clear reason.
- Don't add exported helpers just to compute a path; derive from existing paths or add one shared helper only when reused.

## Commands

- `bun i` - Install dependencies
- `CLAUDECODE=1 bun test` - Run all tests (REQUIRED — default output is too long)
- `bun test <filename>` - Run specific test file
- `bunx tsc --noEmit` - Type-check
- `bun run check .` - Biome checks (format + lint)
- `bun run build` - Build CSS assets
- `bun run cli` - Use CLI directly

## Structure

- **CLI Tool**: Bun + TypeScript global npm package (`npm i -g llm-backlog`)
- **Tasks**: Markdown files in `backlog/` directory
- **Git**: `BACK-123 - Title` commits, `tasks/back-123-feature-name` branches, `gh` for PRs

```
src/
  main.ts             # Entry point: CLI wiring
  index.ts            # Public exports
  agent-instructions.ts  # Agent system prompt generation
  board.ts            # Kanban board logic
  readme.ts           # README generation
  core/               # Domain layer (backlog, search, milestones, sequences, task lifecycle)
  file-system/        # FileSystem class for backlog directory operations
  git/                # GitOperations
  markdown/           # Markdown parser and serializer
  mcp/                # MCP server, tools, HTTP transport
    tools/            # Handlers grouped by domain (tasks/, milestones/, documents/, workflow/)
    resources/        # MCP resource handlers
    utils/            # Milestone resolution, task response formatting
    auth/             # API key, role-based tool filtering
    validation/       # Input validation
    workflow-guides.ts
  server/             # BacklogServer (web UI backend + OAuth)
    routes/           # Route handlers by domain (tasks, milestones, decisions, docs, etc.)
    auth/             # JWT, Google OAuth, middleware, config-repo, users-store
  completions/        # Shell completion helpers
  guidelines/         # Agent guidelines and MCP guidelines docs
  constants/          # Shared constants
  types/              # TypeScript type definitions
  utils/              # id-generators, task-search, task-path, status, etc.
  web/                # React frontend (components, contexts, hooks)
  formatters/         # Output formatters
  test/               # All test files (flat directory)
```

## Key Architectural Rules

- **No circular deps**: `core/` must NEVER import from `server/`, `mcp/`, or `main.ts`.
- **Canonical locations**: `stripPrefix`/`parseTaskIdSegments` → `utils/task-search.ts`; `milestoneKey`/`normalizeMilestoneName` → `core/milestones.ts`; ID generators → `utils/id-generators.ts`.

## Code Standards

- **Runtime**: Bun + TypeScript 5
- **Formatting**: Biome, tab indentation, double quotes

## Testing

One integration test file: `src/test/integration.test.ts`. No unit tests.

**Two git repos per test suite:**
- **Config repo** (`tmp/cfg-repo-*`): local git repo with `users.md` containing mock users and API keys. Used as `AUTH_CONFIG_REPO` so `ConfigRepoService` clones it and enables MCP auth.
- **Project repo** (`tmp/proj-repo-*`): local git repo with a full backlog structure and mock data (tasks, milestones, decisions, docs, config.yml).

**What to test:** HTTP endpoints and MCP protocol only — black box. No internal classes.
- REST endpoints via `fetch()` with `Authorization: Bearer <api-key>`
- MCP via `POST /mcp` with JSON-RPC 2.0 payloads
- Git state: verify commits were created and files are tracked after mutations

**Setup pattern:**
```typescript
async function startTestEnv(): Promise<TestEnv> {
  await buildConfigRepo(configDir);   // git init + users.md
  await buildProjectRepo(projectDir); // git init + mock backlog data
  process.env.AUTH_CONFIG_REPO = configDir;
  const server = new BacklogServer(projectDir);
  await server.start(port, false);    // false = no browser
  ...
}
```

**MCP tool names:** `task_create`, `task_list`, `task_edit`, `task_view`, `task_archive`, `task_complete`, `task_search`.

**Notes:**
- REST auth requires Google OAuth (`GOOGLE_CLIENT_ID` + `AUTH_CONFIG_REPO`) — not tested here.
- MCP auth works with API key only (`AUTH_CONFIG_REPO` alone).
- Task/decision/doc mutations via `core.*` methods do auto-commit when `auto_commit: true`.

## MCP Architecture

- **Pure protocol wrapper**: translation only — no business logic, no feature extensions
- **CLI feature parity**: MCP = strict subset of CLI capabilities
- **Core API only**: never direct filesystem/git

## CLI Multi-line Input

Use `$'Line1\nLine2'` (ANSI-C quoting) or `"$(printf 'Line1\nLine2')"`. Plain `"...\n..."` passes literal backslash-n.
