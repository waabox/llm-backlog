<!-- BACKLOG.MD MCP GUIDELINES START -->

<CRITICAL_INSTRUCTION>

## BACKLOG WORKFLOW INSTRUCTIONS

This project uses Backlog.md MCP for all task and project management.

**CRITICAL RESOURCE**: Read `backlog://workflow/overview` to understand when and how to use Backlog for this project.

- **First time working here?** Read the overview resource IMMEDIATELY to learn the workflow
- **Already familiar?** You should have the overview cached ("## Backlog.md Overview (MCP)")
- **When to read it**: BEFORE creating tasks, or when you're unsure whether to track work

</CRITICAL_INSTRUCTION>

<!-- BACKLOG.MD MCP GUIDELINES END -->

When working on a task, assign it yourself: `-a @{your-name}`

After implementation, simplify: you know more about the task now than when you started.

## Simplicity-first

- Prefer a single implementation for similar concerns. Reuse or refactor instead of duplicating.
- Keep APIs minimal. Favor `load` + `upsert` over load/save/update. Don't add unused methods.
- Avoid extra layers (services, normalizers, versioning) unless immediately proven needed.
- Keep behavior consistent across similar stores. Divergence requires a clear reason.
- Don't add exported helpers just to compute a path; derive from existing paths or add one shared helper only when reused.

## Commands

- `bun i` - Install dependencies
- `CLAUDECODE=1 bun test` - Run all tests (REQUIRED - default output is too long)
- `bun test <filename>` - Run specific test file
- `bunx tsc --noEmit` - Type-check
- `bun run check .` - Biome checks (format + lint)
- `bun run build` - Build CLI
- `bun run cli` - Use CLI directly
- `bun run benchmark` - Performance benchmark

## Structure

- **CLI Tool**: Bun + TypeScript global npm package (`npm i -g backlog.md`)
- **Tasks**: Markdown files in `backlog/` directory
- **Git**: `BACK-123 - Title` commits, `tasks/back-123-feature-name` branches, `gh` for PRs

```
src/
  cli.ts          # Thin shell: splash, config migration, command wiring
  commands/       # CLI command modules (one file per command group)
    shared.ts     # requireProjectRoot, isPlainRequested, etc.
    task-helpers.ts  # buildTaskFromOptions, normalizeDependencies
  core/           # Domain layer (Core class, search, milestones, sequences)
  file-system/    # FileSystem class for backlog directory operations
  git/            # GitOperations
  markdown/       # Markdown parser and serializer
  mcp/            # MCP server, tools, HTTP transport
    tools/        # Handlers grouped by domain (tasks/, milestones/, documents/)
    utils/        # milestone resolution, task response formatting
    auth/         # API key, role-based tool filtering
  server/         # BacklogServer (web UI backend + OAuth)
  types/          # TypeScript type definitions
  utils/          # id-generators, task-search, task-path, status, etc.
  ui/             # TUI components
  web/            # React frontend (components, contexts, hooks)
  formatters/     # Output formatters
  test/           # All test files (flat directory)
```

## Key Architectural Rules

- **cli.ts is a thin shell**: All command logic lives in `src/commands/`.
- **One command per file**: Each CLI command group has its own file in `src/commands/`.
- **Shared helpers**: `shared.ts` or `task-helpers.ts`. No duplication.
- **No circular deps**: `core/` must NEVER import from `commands/` or `cli.ts`.
- **Canonical locations**: `stripPrefix`/`parseTaskIdSegments` → `utils/task-search.ts`; `milestoneKey`/`normalizeMilestoneName` → `core/milestones.ts`; ID generators → `utils/id-generators.ts`.

## Code Standards

- **Runtime**: Bun + TypeScript 5
- **Formatting**: Biome, tab indentation, double quotes
- **Pre-commit**: Husky + lint-staged runs `biome check --write` on staged files

## MCP Architecture

- **Pure protocol wrapper**: translation only — no business logic, no feature extensions
- **CLI feature parity**: MCP = strict subset of CLI capabilities
- **Core API only**: never direct filesystem/git
- **Local dev only**: stdio transport

## CLI Multi-line Input

Use `$'Line1\nLine2'` (ANSI-C quoting) or `"$(printf 'Line1\nLine2')"`. Plain `"...\n..."` passes literal backslash-n.
