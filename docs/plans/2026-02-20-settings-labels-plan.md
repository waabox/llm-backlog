# Settings Page (Labels & Full Config Editing) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/settings` page with tabbed UI (General | Labels | Statuses | Advanced) that reads and writes `config.yml`, always committing and pushing changes to git.

**Architecture:** A new `PUT /api/config` backend endpoint saves config via `ConfigStore.saveConfig()`, stages via `GitOperations.addFile()`, commits, and best-effort pushes. The React `SettingsPage` component manages local form state and calls this endpoint on "Save & Push". All connected tabs refresh via the existing WebSocket `config-updated` broadcast.

**Tech Stack:** Bun + TypeScript, React 18, Tailwind CSS, existing `GitOperations` and `ConfigStore` classes.

---

### Task 1: Add `commitAndPush` to GitOperations

**Files:**
- Modify: `src/git/operations.ts` (add after `commitChanges` around line 65)

**Step 1: Open the file and locate `commitChanges`**

Read `src/git/operations.ts` lines 58–65 to confirm the location. The new method goes right after it.

**Step 2: Add the method**

Insert this after the closing brace of `commitChanges`:

```typescript
async commitAndPush(message: string, repoRoot?: string | null): Promise<void> {
	const args = ["commit", "-m", message];
	if (this.config?.bypassGitHooks) {
		args.push("--no-verify");
	}
	await this.execGit(args, { cwd: repoRoot ?? undefined });
	try {
		await this.execGit(["push", "origin", "HEAD"], { cwd: repoRoot ?? undefined });
	} catch (error) {
		console.error("Config push failed (non-fatal):", error);
	}
}
```

Note: `execGit` is private but accessible since this method is inside the class. The push error is caught and logged — config save and commit are the critical operations; push failure is non-fatal (no remote in dev, CI, etc.).

**Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/git/operations.ts
git commit -m "feat(git): add commitAndPush for unconditional commit+push"
```

---

### Task 2: Add `handleUpdateConfig` route handler

**Files:**
- Modify: `src/server/routes/config.ts`

**Step 1: Read the current file**

Read `src/server/routes/config.ts` lines 1–22 to see the existing imports and `handleGetConfig` pattern.

**Step 2: Add the handler at the bottom of the file**

```typescript
export async function handleUpdateConfig(core: Core, req: Request): Promise<Response> {
	try {
		const body = (await req.json()) as Partial<BacklogConfig>;
		const current = await core.filesystem.loadConfig();
		if (!current) {
			return Response.json({ error: "Configuration not found" }, { status: 404 });
		}
		const updated: BacklogConfig = { ...current, ...body };
		await core.filesystem.saveConfig(updated);
		try {
			await core.git.addFile(core.filesystem.configFilePath);
			await core.git.commitAndPush("chore(config): update project configuration");
		} catch (gitError) {
			console.error("Config git operation failed (non-fatal):", gitError);
		}
		return Response.json(updated);
	} catch (error) {
		console.error("Error updating config:", error);
		return Response.json({ error: "Failed to update configuration" }, { status: 500 });
	}
}
```

The `BacklogConfig` type is already imported via `Core`'s type system; add it to the import at the top if needed:
```typescript
import type { BacklogConfig } from "../../types/index.ts";
```

**Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

---

### Task 3: Wire `PUT /api/config` in the server

**Files:**
- Modify: `src/server/index.ts`

**Step 1: Read the route block**

Read `src/server/index.ts` lines 273–280. You will see:
```typescript
"/api/config": {
    GET: this.protect(async () => await handleGetConfig(this.core)),
},
```

**Step 2: Add the import**

Find the line that imports `handleGetConfig` from `./routes/config.ts` and add `handleUpdateConfig` to it:
```typescript
import { handleGetConfig, handleGetStatuses, handleGetVersion, handleGetStatus, handleGetStatistics, handleUpdateConfig } from "./routes/config.ts";
```

**Step 3: Add PUT to the route object**

Replace the `/api/config` entry with:
```typescript
"/api/config": {
    GET: this.protect(async () => await handleGetConfig(this.core)),
    PUT: this.protect(async (req: Request) => await handleUpdateConfig(this.core, req)),
},
```

**Step 4: Add broadcast after the handler responds**

The handler already returns the response. To broadcast the update, wrap the PUT handler:
```typescript
PUT: this.protect(async (req: Request) => {
    const res = await handleUpdateConfig(this.core, req);
    if (res.ok) this.broadcastConfigUpdated();
    return res;
}),
```

**Step 5: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/server/routes/config.ts src/server/index.ts
git commit -m "feat(api): add PUT /api/config endpoint with git commit+push"
```

---

### Task 4: Integration test for `PUT /api/config`

**Files:**
- Modify: `src/test/integration.test.ts`

**Step 1: Read the existing test structure**

Read `src/test/integration.test.ts` lines 267–330 to see the `describe("REST API — tasks"` block pattern.

**Step 2: Add a new describe block for config**

Add this block after the last `describe` block but before the end of the file:

```typescript
describe("REST API — config", () => {
	let env: TestEnv;

	beforeAll(async () => {
		env = await startTestEnv();
	});

	afterAll(async () => {
		await stopTestEnv(env);
	});

	test("GET /api/config returns full config", async () => {
		const res = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders });
		expect(res.status).toBe(200);
		const config = await res.json();
		expect(config.projectName).toBe("Integration Test Project");
		expect(Array.isArray(config.labels)).toBe(true);
		expect(Array.isArray(config.statuses)).toBe(true);
	});

	test("PUT /api/config updates labels and commits", async () => {
		const current = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders }).then((r) => r.json());
		const logBefore = await gitLog(env.projectDir);

		const updated = { ...current, labels: ["bug", "feature", "enhancement"] };
		const res = await fetch(`${env.baseUrl}/api/config`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify(updated),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.labels).toEqual(["bug", "feature", "enhancement"]);

		// Verify config was persisted
		const refetched = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders }).then((r) => r.json());
		expect(refetched.labels).toEqual(["bug", "feature", "enhancement"]);

		// Verify a new commit was created
		const logAfter = await gitLog(env.projectDir);
		expect(logAfter.length).toBeGreaterThan(logBefore.length);
		expect(logAfter[0]).toContain("update project configuration");
	});

	test("PUT /api/config updates statuses", async () => {
		const current = await fetch(`${env.baseUrl}/api/config`, { headers: env.adminHeaders }).then((r) => r.json());

		const updated = { ...current, statuses: ["Backlog", "In Progress", "Review", "Done"] };
		const res = await fetch(`${env.baseUrl}/api/config`, {
			method: "PUT",
			headers: env.adminHeaders,
			body: JSON.stringify(updated),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.statuses).toEqual(["Backlog", "In Progress", "Review", "Done"]);
	});
});
```

**Step 3: Run the new tests**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts 2>&1 | grep -A5 "REST API — config"
```

Expected: 3 passing tests.

**Step 4: Run all tests to check for regressions**

```bash
CLAUDECODE=1 bun test
```

Expected: all tests pass.

**Step 5: Commit**

```bash
git add src/test/integration.test.ts
git commit -m "test(api): add integration tests for PUT /api/config"
```

---

### Task 5: Add `updateConfig` to the API client

**Files:**
- Modify: `src/web/lib/api.ts`

**Step 1: Read the `fetchConfig` method**

Read `src/web/lib/api.ts` around lines 305–313 (the `fetchConfig` method).

**Step 2: Add `updateConfig` right after `fetchConfig`**

```typescript
async updateConfig(config: BacklogConfig): Promise<BacklogConfig> {
  const response = await fetch(`${API_BASE}/config`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...this.authHeaders() },
    body: JSON.stringify(config),
  });
  if (!response.ok) {
    throw new Error("Failed to update config");
  }
  return response.json();
}
```

Check the import at the top of `api.ts` — `BacklogConfig` may need to be imported:
```typescript
import type { BacklogConfig } from "../../types/index.ts";
```

**Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 4: Commit**

```bash
git add src/web/lib/api.ts
git commit -m "feat(api-client): add updateConfig method"
```

---

### Task 6: Create `SettingsPage.tsx`

**Files:**
- Create: `src/web/components/SettingsPage.tsx`

**Step 1: Read an existing page for patterns**

Read `src/web/components/SideNavigation.tsx` lines 27–130 for the Tailwind class patterns used in this project (colors, spacing, dark mode).

**Step 2: Create the component**

```tsx
import { useState, useEffect } from "react";
import { apiClient } from "../lib/api.ts";
import type { BacklogConfig } from "../../types/index.ts";

type Tab = "general" | "labels" | "statuses" | "advanced";

function ChipInput({
	items,
	onAdd,
	onRemove,
	placeholder,
}: {
	items: string[];
	onAdd: (item: string) => void;
	onRemove: (item: string) => void;
	placeholder: string;
}) {
	const [input, setInput] = useState("");

	const add = () => {
		const trimmed = input.trim();
		if (trimmed && !items.includes(trimmed)) {
			onAdd(trimmed);
			setInput("");
		}
	};

	return (
		<div className="space-y-3">
			<div className="flex gap-2">
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && add()}
					placeholder={placeholder}
					className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
				/>
				<button
					type="button"
					onClick={add}
					className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
				>
					+ Add
				</button>
			</div>
			<div className="flex flex-wrap gap-2">
				{items.map((item) => (
					<span
						key={item}
						className="inline-flex items-center gap-1 px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-sm"
					>
						{item}
						<button
							type="button"
							onClick={() => onRemove(item)}
							className="ml-1 text-gray-400 hover:text-red-500 transition-colors leading-none"
							aria-label={`Remove ${item}`}
						>
							×
						</button>
					</span>
				))}
				{items.length === 0 && <span className="text-sm text-gray-400 dark:text-gray-500 italic">None defined</span>}
			</div>
		</div>
	);
}

export function SettingsPage() {
	const [config, setConfig] = useState<BacklogConfig | null>(null);
	const [activeTab, setActiveTab] = useState<Tab>("labels");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const [labels, setLabels] = useState<string[]>([]);
	const [statuses, setStatuses] = useState<string[]>([]);
	const [projectName, setProjectName] = useState("");
	const [defaultStatus, setDefaultStatus] = useState("");
	const [defaultAssignee, setDefaultAssignee] = useState("");
	const [autoCommit, setAutoCommit] = useState(false);
	const [autoOpenBrowser, setAutoOpenBrowser] = useState(false);
	const [maxColumnWidth, setMaxColumnWidth] = useState(20);
	const [activeBranchDays, setActiveBranchDays] = useState(10);

	useEffect(() => {
		apiClient.fetchConfig().then((cfg) => {
			setConfig(cfg);
			setLabels(cfg.labels ?? []);
			setStatuses(cfg.statuses ?? []);
			setProjectName(cfg.projectName ?? "");
			setDefaultStatus(cfg.defaultStatus ?? "");
			setDefaultAssignee(cfg.defaultAssignee ?? "");
			setAutoCommit(cfg.autoCommit ?? false);
			setAutoOpenBrowser(cfg.autoOpenBrowser ?? false);
			setMaxColumnWidth(cfg.maxColumnWidth ?? 20);
			setActiveBranchDays(cfg.activeBranchDays ?? 10);
		});
	}, []);

	const handleSave = async () => {
		if (!config) return;
		setSaving(true);
		setError(null);
		setSuccess(false);
		try {
			const updated = await apiClient.updateConfig({
				...config,
				labels,
				statuses,
				projectName,
				defaultStatus: defaultStatus || undefined,
				defaultAssignee: defaultAssignee || undefined,
				autoCommit,
				autoOpenBrowser,
				maxColumnWidth,
				activeBranchDays,
			});
			setConfig(updated);
			setSuccess(true);
			setTimeout(() => setSuccess(false), 3000);
		} catch {
			setError("Failed to save settings. Please try again.");
		} finally {
			setSaving(false);
		}
	};

	const tabs: { id: Tab; label: string }[] = [
		{ id: "general", label: "General" },
		{ id: "labels", label: "Labels" },
		{ id: "statuses", label: "Statuses" },
		{ id: "advanced", label: "Advanced" },
	];

	const tabClass = (id: Tab) =>
		`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
			activeTab === id
				? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
				: "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:border-gray-300"
		}`;

	const inputClass =
		"border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full max-w-sm";

	const labelClass = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

	if (!config) {
		return (
			<div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
				Loading settings…
			</div>
		);
	}

	return (
		<div className="p-6 max-w-3xl mx-auto">
			<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">Settings</h1>

			{/* Tabs */}
			<div className="border-b border-gray-200 dark:border-gray-700 mb-6 flex gap-1">
				{tabs.map((t) => (
					<button key={t.id} type="button" onClick={() => setActiveTab(t.id)} className={tabClass(t.id)}>
						{t.label}
					</button>
				))}
			</div>

			{/* Tab content */}
			<div className="space-y-6">
				{activeTab === "general" && (
					<>
						<div>
							<label className={labelClass}>Project Name</label>
							<input
								type="text"
								value={projectName}
								onChange={(e) => setProjectName(e.target.value)}
								className={inputClass}
							/>
						</div>
						<div>
							<label className={labelClass}>Default Status</label>
							<select
								value={defaultStatus}
								onChange={(e) => setDefaultStatus(e.target.value)}
								className={inputClass}
							>
								<option value="">— none —</option>
								{statuses.map((s) => (
									<option key={s} value={s}>
										{s}
									</option>
								))}
							</select>
						</div>
						<div>
							<label className={labelClass}>Default Assignee</label>
							<input
								type="text"
								value={defaultAssignee}
								onChange={(e) => setDefaultAssignee(e.target.value)}
								placeholder="@username"
								className={inputClass}
							/>
						</div>
					</>
				)}

				{activeTab === "labels" && (
					<div>
						<h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3">Labels</h2>
						<p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
							Labels are used to categorize tasks. Add or remove labels here.
						</p>
						<ChipInput
							items={labels}
							onAdd={(item) => setLabels([...labels, item])}
							onRemove={(item) => setLabels(labels.filter((l) => l !== item))}
							placeholder="New label…"
						/>
					</div>
				)}

				{activeTab === "statuses" && (
					<div>
						<h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3">Statuses</h2>
						<p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
							Statuses define the workflow stages for your tasks.
						</p>
						<ChipInput
							items={statuses}
							onAdd={(item) => setStatuses([...statuses, item])}
							onRemove={(item) => setStatuses(statuses.filter((s) => s !== item))}
							placeholder="New status…"
						/>
					</div>
				)}

				{activeTab === "advanced" && (
					<>
						<div className="flex items-center justify-between">
							<div>
								<div className={labelClass}>Auto Commit</div>
								<p className="text-xs text-gray-500 dark:text-gray-400">Automatically commit changes to git</p>
							</div>
							<button
								type="button"
								onClick={() => setAutoCommit(!autoCommit)}
								className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
									autoCommit ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
								}`}
							>
								<span
									className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
										autoCommit ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</button>
						</div>
						<div className="flex items-center justify-between">
							<div>
								<div className={labelClass}>Auto Open Browser</div>
								<p className="text-xs text-gray-500 dark:text-gray-400">Open browser automatically on server start</p>
							</div>
							<button
								type="button"
								onClick={() => setAutoOpenBrowser(!autoOpenBrowser)}
								className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
									autoOpenBrowser ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
								}`}
							>
								<span
									className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
										autoOpenBrowser ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</button>
						</div>
						<div>
							<label className={labelClass}>Max Column Width</label>
							<input
								type="number"
								value={maxColumnWidth}
								onChange={(e) => setMaxColumnWidth(Number(e.target.value))}
								min={10}
								max={100}
								className={inputClass}
							/>
						</div>
						<div>
							<label className={labelClass}>Active Branch Days</label>
							<input
								type="number"
								value={activeBranchDays}
								onChange={(e) => setActiveBranchDays(Number(e.target.value))}
								min={1}
								max={365}
								className={inputClass}
							/>
						</div>
					</>
				)}
			</div>

			{/* Save & Push button */}
			<div className="mt-8 flex items-center gap-4">
				<button
					type="button"
					onClick={handleSave}
					disabled={saving}
					className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{saving ? "Saving…" : "Save & Push"}
				</button>
				{success && <span className="text-sm text-green-600 dark:text-green-400">Saved and pushed ✓</span>}
				{error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
			</div>
		</div>
	);
}
```

**Step 3: Type-check**

```bash
bunx tsc --noEmit
```

Fix any type errors (likely the `BacklogConfig` import path — verify it matches the project's imports).

**Step 4: Commit**

```bash
git add src/web/components/SettingsPage.tsx
git commit -m "feat(ui): add SettingsPage component with tabbed config editing"
```

---

### Task 7: Wire routing and add Settings nav link

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/components/SideNavigation.tsx`

#### Part A: Add route in App.tsx

**Step 1: Read the routes section**

Read `src/web/App.tsx` lines 515–525 — these are the last few routes before `</Route>`.

**Step 2: Import `SettingsPage`**

Find the imports block at the top of `App.tsx` where other page components are imported. Add:
```typescript
import { SettingsPage } from "./components/SettingsPage.tsx";
```

**Step 3: Add the route**

Add this before the closing `</Route>` of the root layout route (alongside the `statistics` route):
```tsx
<Route path="settings" element={<SettingsPage />} />
```

#### Part B: Add Settings link to SideNavigation.tsx

**Step 1: Read the Icons object**

Read `src/web/components/SideNavigation.tsx` lines 27–130 to find the `Icons` object closing brace.

**Step 2: Add a Settings icon**

Add `Settings` to the `Icons` object (it uses the same gear SVG as `DocumentSettings` but `w-5 h-5`):
```typescript
Settings: () => (
	<svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
		<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
		<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
	</svg>
),
```

**Step 3: Add the Settings NavLink in the expanded nav section**

Read `src/web/components/SideNavigation.tsx` lines 580–600 — around the Statistics link. Add the Settings link after Statistics in the expanded section:

```tsx
{/* Settings Navigation */}
<NavLink
	to="/settings"
	className={({ isActive }) =>
		`flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
			isActive
				? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
				: 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
		}`
	}
>
	<Icons.Settings />
	<span className="ml-3 text-sm font-medium">Settings</span>
</NavLink>
```

**Step 4: Add the collapsed (icon-only) Settings button**

Read `src/web/components/SideNavigation.tsx` lines 795–810 — around the Statistics collapsed button. Add a Settings collapsed button in the same pattern.

**Step 5: Type-check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 6: Build to verify no bundler errors**

```bash
bun run build
```

Expected: builds successfully.

**Step 7: Commit**

```bash
git add src/web/App.tsx src/web/components/SideNavigation.tsx
git commit -m "feat(ui): wire /settings route and add Settings nav link"
```

---

### Task 8: Manual smoke test

**Step 1: Start the server**

```bash
bun run cli -- serve
```

**Step 2: Open the browser**

Navigate to `http://localhost:<port>/settings`.

**Verify:**
- Settings page loads with tabs: General | Labels | Statuses | Advanced
- Labels tab shows current labels from config as chips
- Typing a label and pressing Enter (or clicking Add) adds a chip
- Clicking × on a chip removes it
- Clicking "Save & Push" shows "Saving…" then "Saved and pushed ✓"
- The `backlog/config.yml` file is updated on disk
- `git log` shows a new commit "chore(config): update project configuration"

**Step 3: Run all tests to confirm no regressions**

```bash
CLAUDECODE=1 bun test
```

Expected: all tests pass.
