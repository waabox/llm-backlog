# MCP HTTP Transport with Authentication and Role-Based Access Control

## Overview

Add HTTP/SSE transport to the MCP server with API key authentication and role-based tool filtering. The MCP server will run on a remote server where users don't have direct access. AI tools (Claude Code, Cursor, etc.) connect via HTTP with an API key that maps to a user and role from `users.md`.

Authentication is **opt-in** — if `AUTH_CONFIG_REPO` is not set, HTTP mode runs without auth. Stdio transport remains the default for local development.

## Architecture

```
┌─────────────┐   API key (Bearer)   ┌──────────────────┐   git clone/pull   ┌─────────────┐
│  Claude Code │ ──────────────────── │   MCP Server     │ <──────────────── │ Config Repo  │
│  Cursor      │ <──── SSE/HTTP ───── │   (Bun.serve)    │                    │  (private)   │
│  etc.        │                      │                   │                    │  users.md    │
└─────────────┘                      └──────────────────┘                    └─────────────┘
```

### Flow

1. MCP server starts with `backlog mcp start --http --port 3001`
2. Server clones config repo on startup (reuses `ConfigRepoService`)
3. AI tool sends HTTP request to `/mcp` with `Authorization: Bearer bkmd_...`
4. Server extracts API key, looks up user in `users.md` via `findUserByApiKey()`
5. If not found → 401 Unauthorized
6. If found → creates a fresh stateless MCP transport, tool list filtered by role
7. Response sent, transport discarded — no state kept between requests

### Stateless Design

Every request is independent. No sessions, no session IDs, no server-side state. The MCP SDK supports this natively with `sessionIdGenerator: undefined` (stateless mode). Every request carries the API key, every request is validated independently.

## Config Repo — users.md Extension

The same private config repo from Gmail OAuth is reused. The `users.md` format is extended with an optional `apiKey` field:

```yaml
---
users:
  - email: juan@gmail.com
    name: Juan
    role: admin
    apiKey: bkmd_a1b2c3d4e5f6...
  - email: maria@gmail.com
    name: Maria
    role: viewer
    apiKey: bkmd_x9y8z7w6v5u4...
  - email: pedro@gmail.com
    name: Pedro
    role: admin
---
```

- `apiKey` is optional — users without one can still use the web UI (Gmail OAuth) but can't use MCP remotely
- Keys are prefixed with `bkmd_` for easy identification
- Admin generates keys manually and adds them to `users.md`

## CLI Interface

```bash
# Local dev (current behavior, unchanged)
backlog mcp start

# Remote server with HTTP transport
backlog mcp start --http --port 3001

# Default port is 3001
backlog mcp start --http
```

New flags on `mcp start`:
- `--http` — use HTTP transport instead of stdio
- `--port <number>` — port for HTTP server (default: 3001)

## Transport Layer

Uses `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/sdk`, which works natively with Bun's web standard Request/Response.

**Bun.serve integration:**
- Single route `/mcp` handles all MCP protocol traffic (POST for tool calls, GET for SSE streams, DELETE for session termination)
- Auth check happens before passing the request to the transport
- A fresh transport instance is created per request (stateless mode)

## Role-Based Tool Filtering

Tools are filtered at the protocol level. Viewers never see write tools in the tool list. If a viewer crafts a raw call to a write tool, the server rejects it.

### Tool Permissions

| Tool | Admin | Viewer |
|------|-------|--------|
| `task_list` | yes | yes |
| `task_search` | yes | yes |
| `task_view` | yes | yes |
| `task_create` | yes | no |
| `task_edit` | yes | no |
| `task_archive` | yes | no |
| `task_complete` | yes | no |
| `document_list` | yes | yes |
| `document_view` | yes | yes |
| `document_search` | yes | yes |
| `document_create` | yes | no |
| `document_update` | yes | no |
| `milestone_list` | yes | yes |
| `milestone_add` | yes | no |
| `milestone_rename` | yes | no |
| `milestone_remove` | yes | no |
| `milestone_archive` | yes | no |
| All workflow/guidance tools | yes | yes |

**Rule:** any tool with `_list`, `_search`, `_view`, or `workflow` in its name is read-only. Everything else is write-only (admin required).

## Environment Variables

Reuses the same variables from Gmail OAuth:

| Variable | Required | Description |
|----------|----------|-------------|
| `AUTH_CONFIG_REPO` | Yes (for auth) | URL of the config repo (with credentials if private) |

If `AUTH_CONFIG_REPO` is not set, HTTP mode runs without auth and all tools are available to everyone (development mode).

## What We Reuse from Gmail OAuth

- `ConfigRepoService` — clone config repo on startup, poll every 5 minutes
- `UsersStore` — parse `users.md` YAML frontmatter (extended with `findUserByApiKey`)
- Same `users.md` file, same config repo, same role definitions

## What's New

- `findUserByApiKey()` method on `UsersStore`
- HTTP transport mode in `McpServer` using `WebStandardStreamableHTTPServerTransport`
- `--http` and `--port` CLI flags on `mcp start`
- Tool filtering by role (read-only vs read-write classification)
- API key validation before MCP request handling
- `Bun.serve()` wrapper that routes `/mcp` to the MCP transport

## AI Tool Configuration

```json
{
  "mcpServers": {
    "backlog": {
      "url": "https://my-server:3001/mcp",
      "headers": {
        "Authorization": "Bearer bkmd_a1b2c3d4e5f6..."
      }
    }
  }
}
```

## What Does NOT Change

- Stdio transport — remains the default for `backlog mcp start`
- CLI tool — no auth, works as today
- Web UI — uses Gmail OAuth (separate auth mechanism)
- Task file format — unchanged
- MCP tool implementations — unchanged, only the tool visibility is filtered
