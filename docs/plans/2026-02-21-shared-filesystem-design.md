# Shared FileSystem and GitOperations Between Web and MCP

**Date:** 2026-02-21

## Problem

`BacklogServer` (web UI) and the embedded MCP handler each create their own `Core` instance pointing at the same project directory. Because they have independent `FileSystem` and `GitOperations` objects, their in-memory `ContentStore` caches diverge: a task written by MCP is not immediately visible in the web UI's cache and vice versa.

The existing workaround (`backlogWatcher`) only activates in remote-repo mode, leaving local mode with a subtle sync gap.

## Root Cause

`Core` creates `FileSystem` and `GitOperations` in its constructor. `BacklogServer` and `createMcpRequestHandler` each instantiate `Core` independently, so there are two separate I/O abstractions over the same disk.

## Key Insight: ContentStore Patch Chaining

`ContentStore.patchFilesystem()` monkey-patches `fs.saveTask`, `fs.saveDocument`, and `fs.saveDecision` on the shared `FileSystem` instance. If two `ContentStore`s are given the same `FileSystem`, the second patch wraps the first:

```
fs.saveTask = mcpPatch(webPatch(original))
```

Any write — regardless of which `Core` triggers it — flows through both patches, keeping both caches in sync automatically. No new event bus or OS watcher changes are needed.

## Design

### 1. Core accepts injected infrastructure

Modify `Core`'s constructor to accept optional pre-built `FileSystem` and `GitOperations`:

```typescript
class Core {
  constructor(
    projectRoot: string,
    options?: {
      enableWatchers?: boolean;
      filesystem?: FileSystem;
      gitOperations?: GitOperations;
    }
  )
}
```

When omitted, `Core` creates them as today — fully backwards-compatible with CLI and stdio MCP.

### 2. BacklogServer creates shared instances

```typescript
const sharedFs = new FileSystem(projectPath);
const sharedGit = new GitOperations(projectPath);

this.core = new Core(projectPath, {
  enableWatchers: true,
  filesystem: sharedFs,
  gitOperations: sharedGit,
});
```

### 3. createMcpRequestHandler receives shared instances

```typescript
type McpRequestHandlerOptions = {
  projectRoot: string;
  filesystem?: FileSystem;
  gitOperations?: GitOperations;
  // ...existing fields...
}
```

`createMcpServer` is updated similarly.

### 4. Eager ContentStore initialization

After `createMcpRequestHandler` returns, call `mcpServer.getContentStore()` immediately so the patch chain is established before the first MCP request arrives.

### 5. Remove backlogWatcher

The `backlogWatcher` in `BacklogServer` is no longer needed — the patch chain handles both local and remote modes. Remove the watcher and its setup logic.

## Data Flow After Change

```
BacklogServer
  ├── FileSystem       (1 instance, shared)
  ├── GitOperations    (1 instance, shared)
  ├── Core (web)   → ContentStore → patches fs → webPatch
  └── McpServer    → ContentStore → patches fs → mcpPatch(webPatch(original))

Any write (web or MCP):
  mcpPatch fires → updates MCP cache
  webPatch fires  → updates Web cache
  original fires  → writes to disk
```

## Backwards Compatibility

- `Core(projectRoot)` with no options still works exactly as before.
- CLI commands, stdio MCP, and integration tests are unaffected.
- The only callers that change are `BacklogServer` and `createMcpRequestHandler`.

## Files Affected

- `src/core/backlog.ts` — accept `filesystem` and `gitOperations` options
- `src/mcp/http-transport.ts` — pass through `filesystem` and `gitOperations` to `createMcpServer`
- `src/mcp/server.ts` — `createMcpServer` accepts and forwards shared instances
- `src/server/index.ts` — create shared instances, pass to both Core and mcpHandler, remove `backlogWatcher`
