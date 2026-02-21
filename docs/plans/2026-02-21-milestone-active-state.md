# Milestone Active State Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an `active: boolean` field to milestones so only active ones appear in the Kanban Board, while all appear in the Milestones view.

**Architecture:** Add `active` to the Milestone type and frontmatter. Existing milestones without the field default to `true` (backwards compatible). New milestones are created with `active: false`. A new MCP tool and REST endpoint allow toggling the field. Board.tsx filters milestone lanes to active-only; MilestonesPage shows all with a toggle.

**Tech Stack:** TypeScript, Bun, React, markdown frontmatter parsed via `gray-matter`

---

### Task 1: Add `active` field to Milestone type and parser

**Files:**
- Modify: `src/types/index.ts:137-142`
- Modify: `src/markdown/parser.ts:214-223`

**Step 1: Add `active: boolean` to the Milestone interface**

In `src/types/index.ts`, change:
```typescript
export interface Milestone {
	id: string;
	title: string;
	description: string;
	readonly rawContent: string;
}
```
To:
```typescript
export interface Milestone {
	id: string;
	title: string;
	description: string;
	active: boolean;
	readonly rawContent: string;
}
```

**Step 2: Update `parseMilestone` to read `active` from frontmatter**

In `src/markdown/parser.ts`, change:
```typescript
export function parseMilestone(content: string): Milestone {
	const { frontmatter, content: rawContent } = parseMarkdown(content);

	return {
		id: String(frontmatter.id || ""),
		title: String(frontmatter.title || ""),
		description: extractSection(rawContent, "Description") || "",
		rawContent,
	};
}
```
To:
```typescript
export function parseMilestone(content: string): Milestone {
	const { frontmatter, content: rawContent } = parseMarkdown(content);

	return {
		id: String(frontmatter.id || ""),
		title: String(frontmatter.title || ""),
		description: extractSection(rawContent, "Description") || "",
		// Missing field defaults to true for backwards compatibility with existing milestone files.
		active: frontmatter.active !== undefined ? Boolean(frontmatter.active) : true,
		rawContent,
	};
}
```

**Step 3: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: type errors in files that construct `Milestone` objects without `active` (milestone-store.ts, integration tests). These are fixed in the next tasks.

**Step 4: Commit**

```bash
git add src/types/index.ts src/markdown/parser.ts
git commit -m "feat: add active field to Milestone type and parser"
```

---

### Task 2: Update MilestoneStore to write and update `active`

**Files:**
- Modify: `src/file-system/milestone-store.ts:269-277` (`serializeMilestoneContent`)
- Modify: `src/file-system/milestone-store.ts:117-126` (`createMilestone` return)
- Add method: `updateMilestoneActive` to `MilestoneStore`

**Step 1: Update `serializeMilestoneContent` to include `active`**

In `src/file-system/milestone-store.ts`, change:
```typescript
private serializeMilestoneContent(id: string, title: string, rawContent: string): string {
	return `---
id: ${id}
title: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
---

${rawContent.trim()}
`;
}
```
To:
```typescript
private serializeMilestoneContent(id: string, title: string, rawContent: string, active = false): string {
	return `---
id: ${id}
title: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
active: ${active}
---

${rawContent.trim()}
`;
}
```

**Step 2: Update `createMilestone` return to include `active: false`**

In `src/file-system/milestone-store.ts`, change the `return` block in `createMilestone`:
```typescript
		return {
			id,
			title,
			description: description || `Milestone: ${title}`,
			rawContent: parseMilestone(content).rawContent,
		};
```
To:
```typescript
		return {
			id,
			title,
			description: description || `Milestone: ${title}`,
			active: false,
			rawContent: parseMilestone(content).rawContent,
		};
```

**Step 3: Add `updateMilestoneActive` method to `MilestoneStore`**

Add this method before the private methods (after `archiveMilestone`):
```typescript
async updateMilestoneActive(identifier: string, active: boolean): Promise<{ success: boolean; milestone?: Milestone }> {
	const normalized = identifier.trim();
	if (!normalized) {
		return { success: false };
	}

	try {
		const milestoneMatch = await this.findMilestoneFile(normalized, "active");
		if (!milestoneMatch) {
			return { success: false };
		}

		const { milestone, filepath } = milestoneMatch;
		const updatedContent = this.serializeMilestoneContent(milestone.id, milestone.title, milestone.rawContent, active);
		await Bun.write(filepath, updatedContent);

		return { success: true, milestone: parseMilestone(updatedContent) };
	} catch {
		return { success: false };
	}
}
```

**Step 4: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: remaining errors in `backlog.ts` and server routes (fixed next).

**Step 5: Commit**

```bash
git add src/file-system/milestone-store.ts
git commit -m "feat: serialize active field in milestone files, add updateMilestoneActive"
```

---

### Task 3: Expose `setMilestoneActive` in Core

**Files:**
- Modify: `src/core/archive-service.ts` — add `setMilestoneActive` function
- Modify: `src/core/backlog.ts` — add `setMilestoneActive` method

**Step 1: Add `setMilestoneActive` to `archive-service.ts`**

Add at the end of `src/core/archive-service.ts`:
```typescript
/**
 * Sets the active state of a milestone.
 *
 * @param core - The Core instance.
 * @param identifier - The milestone ID or name.
 * @param active - Whether the milestone is active.
 * @param autoCommit - Whether to commit the change to git.
 * @returns Result object with success status and updated milestone.
 */
export async function setMilestoneActive(
	core: Core,
	identifier: string,
	active: boolean,
	autoCommit?: boolean,
): Promise<{ success: boolean; milestone?: Milestone }> {
	const result = await core.fs.updateMilestoneActive(identifier, active);
	if (!result.success || !result.milestone) {
		return { success: false };
	}

	if (await core.shouldAutoCommit(autoCommit)) {
		const label = result.milestone.id ? ` ${result.milestone.id}` : "";
		const backlogDir = DEFAULT_DIRECTORIES.BACKLOG;
		const repoRoot = await core.git.stageBacklogDirectory(backlogDir);
		await core.git.commitChanges(`backlog: Set milestone${label} active=${active}`, repoRoot);
	}

	return { success: true, milestone: result.milestone };
}
```

Note: import `DEFAULT_DIRECTORIES` from the constants file if not already imported (check existing imports at top of `archive-service.ts`).

**Step 2: Import and expose in `backlog.ts`**

Add `setMilestoneActive` to the import from `archive-service.ts`, then add this method to the `Core` class (after `renameMilestone`):
```typescript
async setMilestoneActive(identifier: string, active: boolean, autoCommit?: boolean): Promise<{ success: boolean; milestone?: Milestone }> {
	return setMilestoneActive(this, identifier, active, autoCommit);
}
```

**Step 3: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: clean or only remaining web/server errors.

**Step 4: Commit**

```bash
git add src/core/archive-service.ts src/core/backlog.ts
git commit -m "feat: expose setMilestoneActive in Core"
```

---

### Task 4: REST API route + API client

**Files:**
- Modify: `src/server/routes/milestones.ts` — add `handleSetMilestoneActive`
- Modify: `src/server/index.ts` — register `PUT /api/milestones/:id/active`
- Modify: `src/web/lib/api.ts` — add `setMilestoneActive` client method

**Step 1: Add `handleSetMilestoneActive` to the route file**

Add to `src/server/routes/milestones.ts`:
```typescript
export async function handleSetMilestoneActive(
	milestoneId: string,
	req: Request,
	core: Core,
	broadcast: () => void,
): Promise<Response> {
	try {
		const body = (await req.json()) as { active?: unknown };
		if (typeof body.active !== "boolean") {
			return Response.json({ error: "active must be a boolean" }, { status: 400 });
		}

		const result = await core.setMilestoneActive(milestoneId, body.active);
		if (!result.success) {
			return Response.json({ error: "Milestone not found" }, { status: 404 });
		}
		broadcast();
		return Response.json({ success: true, milestone: result.milestone ?? null });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to update milestone";
		console.error("Error setting milestone active:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}
```

**Step 2: Register the route in `server/index.ts`**

Import `handleSetMilestoneActive` alongside the other milestone handlers, then add a route entry after `/api/milestones/:id/archive`:
```typescript
"/api/milestones/:id/active": {
	PUT: this.protect(
		async (req: Request & { params: { id: string } }) =>
			await handleSetMilestoneActive(req.params.id, req, this.core, () => this.broadcastTasksUpdated()),
	),
},
```

**Step 3: Add `setMilestoneActive` to the API client**

In `src/web/lib/api.ts`, add after `archiveMilestone`:
```typescript
async setMilestoneActive(id: string, active: boolean): Promise<{ success: boolean; milestone?: Milestone | null }> {
	const response = await fetch(`${API_BASE}/milestones/${encodeURIComponent(id)}/active`, {
		method: "PUT",
		headers: { "Content-Type": "application/json", ...this.authHeaders() },
		body: JSON.stringify({ active }),
	});
	const data = await response.json();
	if (!response.ok) {
		throw new Error(data.error || "Failed to update milestone");
	}
	return data;
}
```

**Step 4: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: clean.

**Step 5: Commit**

```bash
git add src/server/routes/milestones.ts src/server/index.ts src/web/lib/api.ts
git commit -m "feat: add PUT /api/milestones/:id/active route and API client method"
```

---

### Task 5: MCP tool `milestone_set_active`

**Files:**
- Modify: `src/mcp/tools/milestones/schemas.ts` — add `milestoneSetActiveSchema`
- Modify: `src/mcp/tools/milestones/handlers.ts` — add `MilestoneSetActiveArgs` and handler method
- Modify: `src/mcp/tools/milestones/index.ts` — register the tool

**Step 1: Add schema**

In `src/mcp/tools/milestones/schemas.ts`, add at the end:
```typescript
export const milestoneSetActiveSchema: JsonSchema = {
	type: "object",
	properties: {
		name: {
			type: "string",
			minLength: 1,
			maxLength: 100,
			description: "Milestone name or ID (case-insensitive match)",
		},
		active: {
			type: "boolean",
			description: "Set to true to activate (shows in Kanban board), false to deactivate",
		},
	},
	required: ["name", "active"],
	additionalProperties: false,
};
```

**Step 2: Add args type and handler method**

In `src/mcp/tools/milestones/handlers.ts`:

Add the args type near the top (with the other arg types):
```typescript
export type MilestoneSetActiveArgs = {
	name: string;
	active: boolean;
};
```

Add the method to `MilestoneHandlers` class (after `archiveMilestone`):
```typescript
async setMilestoneActive(args: MilestoneSetActiveArgs): Promise<CallToolResult> {
	const name = normalizeMilestoneName(args.name);
	if (!name) {
		throw new McpError("Milestone name cannot be empty.", "VALIDATION_ERROR");
	}

	const result = await this.core.setMilestoneActive(name, args.active);
	if (!result.success) {
		throw new McpError(`Milestone not found: "${name}"`, "NOT_FOUND");
	}

	const label = result.milestone?.title ?? name;
	const id = result.milestone?.id;
	const stateLabel = args.active ? "activated" : "deactivated";

	return {
		content: [
			{
				type: "text",
				text: `Milestone "${label}"${id ? ` (${id})` : ""} ${stateLabel}.`,
			},
		],
	};
}
```

**Step 3: Register the tool**

In `src/mcp/tools/milestones/index.ts`:

Import `milestoneSetActiveSchema` and `MilestoneSetActiveArgs`:
```typescript
import { milestoneSetActiveSchema } from "./schemas.ts";
// MilestoneSetActiveArgs already available from handlers.ts
```

Register the tool inside `registerMilestoneTools`:
```typescript
const setActiveTool: McpToolHandler = createSimpleValidatedTool(
	{
		name: "milestone_set_active",
		description: "Set a milestone as active (shows in Kanban board) or inactive",
		inputSchema: milestoneSetActiveSchema,
	},
	milestoneSetActiveSchema,
	async (input) => handlers.setMilestoneActive(input as MilestoneSetActiveArgs),
);

server.addTool(setActiveTool);
```

**Step 4: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: clean.

**Step 5: Commit**

```bash
git add src/mcp/tools/milestones/
git commit -m "feat: add milestone_set_active MCP tool"
```

---

### Task 6: Filter inactive milestones from board.ts export

**Files:**
- Modify: `src/board.ts:181-242` (`generateMilestoneGroupedBoard`)

**Step 1: Filter `milestoneEntities` at the start of the function**

In `src/board.ts`, inside `generateMilestoneGroupedBoard`, add a filter after the alias map setup:

Change the beginning of the function body (after the `now`/`timestamp` block):
```typescript
	const aliasMap = buildMilestoneAliasMap(milestoneEntities);
```
To:
```typescript
	const activeMilestoneEntities = milestoneEntities.filter((m) => m.active);
	const aliasMap = buildMilestoneAliasMap(activeMilestoneEntities);
```

Then replace all subsequent references to `milestoneEntities` inside the function body with `activeMilestoneEntities`. Specifically:
- `for (const milestone of milestoneEntities)` → `for (const milestone of activeMilestoneEntities)`
- `getMilestoneLabel(milestone, milestoneEntities)` → `getMilestoneLabel(milestone, activeMilestoneEntities)`

**Step 2: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: clean.

**Step 3: Commit**

```bash
git add src/board.ts
git commit -m "feat: filter inactive milestones from markdown kanban export"
```

---

### Task 7: Filter inactive milestones from Board.tsx (web Kanban)

**Files:**
- Modify: `src/web/components/Board.tsx` — filter `milestoneEntities` for lane building

**Step 1: Add filtered milestone entities**

In `Board.tsx`, find the `buildLanes` call (around line 124):
```typescript
() => buildLanes(laneMode, tasks, milestoneEntities.map((milestone) => milestone.id), milestoneEntities, {
```

Add a `useMemo` above it:
```typescript
const activeMilestoneEntities = useMemo(
	() => milestoneEntities.filter((m) => m.active),
	[milestoneEntities],
);
```

Then update the `buildLanes` call to use `activeMilestoneEntities`:
```typescript
() => buildLanes(laneMode, tasks, activeMilestoneEntities.map((milestone) => milestone.id), activeMilestoneEntities, {
	archivedMilestoneIds,
	archivedMilestones,
})
```

**Step 2: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: clean.

**Step 3: Commit**

```bash
git add src/web/components/Board.tsx
git commit -m "feat: filter inactive milestones from kanban board lanes"
```

---

### Task 8: Milestone active badge and toggle in MilestonesPage.tsx

**Files:**
- Modify: `src/web/components/MilestonesPage.tsx`

**Step 1: Add `handleToggleActive` callback**

In `MilestonesPage.tsx`, add a state variable and handler after the existing state declarations:
```typescript
const [togglingActiveKey, setTogglingActiveKey] = useState<string | null>(null);

const handleToggleActive = useCallback(async (milestone: Milestone) => {
	setTogglingActiveKey(milestone.id);
	try {
		await apiClient.setMilestoneActive(milestone.id, !milestone.active);
		await onRefreshData?.();
	} catch (err) {
		setError(err instanceof Error ? err.message : "Failed to update milestone");
	} finally {
		setTogglingActiveKey(null);
	}
}, [onRefreshData]);
```

**Step 2: Display active badge on milestone bucket headers**

In the JSX where each milestone bucket header is rendered, look for where the milestone title/label is shown. Find the `activeMilestones` map rendering and add a badge and toggle button.

Look for the pattern that renders each `bucket.label` heading in `activeMilestones` and `completedMilestones`. Add after the label:

```tsx
{(() => {
	const milestoneEntity = milestoneEntities.find(
		(m) => m.id === bucket.milestone
	);
	if (!milestoneEntity) return null;
	return (
		<span className="flex items-center gap-2">
			<span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
				milestoneEntity.active
					? "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300"
					: "bg-gray-100 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
			}`}>
				{milestoneEntity.active ? "Active" : "Inactive"}
			</span>
			{!isViewer && (
				<button
					type="button"
					disabled={togglingActiveKey === milestoneEntity.id}
					onClick={(e) => { e.stopPropagation(); void handleToggleActive(milestoneEntity); }}
					className="text-xs text-blue-500 hover:underline disabled:opacity-50"
				>
					{milestoneEntity.active ? "Deactivate" : "Activate"}
				</button>
			)}
		</span>
	);
})()}
```

Note: This goes in every milestone bucket header (both `activeMilestones` and `completedMilestones` sections). You'll need to read the full component to find the exact insertion point in the JSX.

**Step 3: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: clean.

**Step 4: Commit**

```bash
git add src/web/components/MilestonesPage.tsx
git commit -m "feat: show active badge and toggle in milestones page"
```

---

### Task 9: Integration tests

**Files:**
- Modify: `src/test/integration.test.ts`

**Step 1: Add test for `milestone_set_active`**

Find a test block that creates and manages milestones in the integration test file. Add a new test group or individual test:

```typescript
it("milestone_set_active: activates and deactivates a milestone", async () => {
	// Create a milestone (active=false by default)
	await callMcp(env, "milestone_add", { name: "Test Sprint" });

	// Verify it is inactive
	let milestones = await fetch(`${env.baseUrl}/api/milestones`, {
		headers: { Authorization: `Bearer ${env.apiKey}` },
	}).then((r) => r.json()) as Array<{ id: string; title: string; active: boolean }>;
	const created = milestones.find((m) => m.title === "Test Sprint");
	expect(created).toBeDefined();
	expect(created!.active).toBe(false);

	// Activate it
	const activateResult = await callMcp(env, "milestone_set_active", { name: "Test Sprint", active: true });
	expect(activateResult.content[0].text).toContain("activated");

	// Verify it is now active
	milestones = await fetch(`${env.baseUrl}/api/milestones`, {
		headers: { Authorization: `Bearer ${env.apiKey}` },
	}).then((r) => r.json()) as Array<{ id: string; title: string; active: boolean }>;
	const afterActivate = milestones.find((m) => m.title === "Test Sprint");
	expect(afterActivate!.active).toBe(true);

	// Deactivate it
	await callMcp(env, "milestone_set_active", { name: "Test Sprint", active: false });
	milestones = await fetch(`${env.baseUrl}/api/milestones`, {
		headers: { Authorization: `Bearer ${env.apiKey}` },
	}).then((r) => r.json()) as Array<{ id: string; title: string; active: boolean }>;
	const afterDeactivate = milestones.find((m) => m.title === "Test Sprint");
	expect(afterDeactivate!.active).toBe(false);
});
```

**Step 2: Run the test to verify it passes**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts
```
Expected: new test passes.

**Step 3: Commit**

```bash
git add src/test/integration.test.ts
git commit -m "test: add milestone_set_active integration test"
```

---

### Task 10: Run full test suite and verify

**Step 1: Run all tests**

```bash
CLAUDECODE=1 bun test
```
Expected: all tests pass.

**Step 2: Run type-check**

```bash
bunx tsc --noEmit
```
Expected: zero errors.

**Step 3: Run linter**

```bash
bun run check .
```
Expected: no errors.
