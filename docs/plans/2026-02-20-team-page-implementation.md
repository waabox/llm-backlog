# Team Page Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `/team` page that lets any user browse tasks grouped by milestone for any team member selected from a dropdown.

**Architecture:** New `TeamPage.tsx` component at route `/team`. User selector populates from `/api/users`. Tasks filtered client-side using same logic as `MyWorkPage`. Modal opens on `/team/:taskId?assignee=...` and returns to `/team?assignee=...` on close.

**Tech Stack:** React 18, React Router v6, TypeScript 5, Tailwind CSS. No new backend endpoints.

---

### Task 1: Create `TeamPage.tsx`

**Files:**
- Create: `src/web/components/TeamPage.tsx`

The component receives the same props as `MyWorkPage` plus an `onEditTask` callback. It reads `?assignee=` from the URL, fetches `/api/users` on mount to populate the dropdown, and renders tasks grouped by milestone using the same milestone-grouping logic already in `MyWorkPage`.

**Step 1: Create the file**

```tsx
import React, { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Milestone, Task } from "../../types";
import { apiClient } from "../lib/api";
import MilestoneTaskRow from "./MilestoneTaskRow";

interface User {
	email: string;
	name: string;
}

interface TeamPageProps {
	tasks: Task[];
	milestoneEntities: Milestone[];
	onEditTask: (task: Task) => void;
}

const NO_MILESTONE_KEY = "__none__";

const isDoneStatus = (status?: string | null): boolean => {
	const normalized = (status ?? "").toLowerCase();
	return normalized.includes("done") || normalized.includes("complete");
};

const getStatusBadgeClass = (status?: string | null): string => {
	const normalized = (status ?? "").toLowerCase();
	if (normalized.includes("done") || normalized.includes("complete"))
		return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300";
	if (normalized.includes("progress"))
		return "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300";
	return "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300";
};

const getPriorityBadgeClass = (priority?: string): string => {
	switch (priority?.toLowerCase()) {
		case "high":
			return "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300";
		case "medium":
			return "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300";
		case "low":
			return "bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300";
		default:
			return "";
	}
};

const noop = () => {};

interface TaskGroup {
	key: string;
	label: string;
	tasks: Task[];
}

const TeamPage: React.FC<TeamPageProps> = ({ tasks, milestoneEntities, onEditTask }) => {
	const [users, setUsers] = useState<User[]>([]);
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const assigneeFilter = searchParams.get("assignee") ?? "";
	const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

	useEffect(() => {
		apiClient.fetchUsers().then(setUsers).catch(() => setUsers([]));
	}, []);

	const toggleGroup = (key: string): void => {
		setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	const handleSelectUser = (email: string): void => {
		if (email) {
			navigate(`/team?assignee=${encodeURIComponent(email)}`);
		} else {
			navigate("/team");
		}
	};

	const assignedTasks = useMemo((): Task[] => {
		if (!assigneeFilter) return [];
		return tasks.filter((task) =>
			(task.assignee ?? []).some((entry) => entry.includes(assigneeFilter)),
		);
	}, [tasks, assigneeFilter]);

	const groups = useMemo((): TaskGroup[] => {
		const milestoneMap = new Map<string, Milestone>(
			milestoneEntities.map((m) => [m.id, m]),
		);
		const byKey = new Map<string, Task[]>();
		for (const task of assignedTasks) {
			const key = task.milestone ?? NO_MILESTONE_KEY;
			const existing = byKey.get(key);
			if (existing) {
				existing.push(task);
			} else {
				byKey.set(key, [task]);
			}
		}
		const result: TaskGroup[] = [];
		for (const [key, groupTasks] of byKey.entries()) {
			if (key === NO_MILESTONE_KEY) continue;
			const milestone = milestoneMap.get(key);
			result.push({ key, label: milestone?.title ?? key, tasks: groupTasks });
		}
		const noMilestoneTasks = byKey.get(NO_MILESTONE_KEY);
		if (noMilestoneTasks && noMilestoneTasks.length > 0) {
			result.push({ key: NO_MILESTONE_KEY, label: "No Milestone", tasks: noMilestoneTasks });
		}
		return result;
	}, [assignedTasks, milestoneEntities]);

	const selectedUser = users.find((u) => u.email === assigneeFilter);

	return (
		<div className="container mx-auto px-4 py-8 bg-gray-50 dark:bg-gray-900 min-h-full transition-colors duration-200">
			{/* Page header */}
			<div className="mb-6">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">Team</h1>
				<p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
					Browse tasks by team member
				</p>
			</div>

			{/* User selector */}
			<div className="mb-6">
				<select
					value={assigneeFilter}
					onChange={(e) => handleSelectUser(e.target.value)}
					className="block w-64 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-stone-500 dark:focus:ring-stone-400 focus:border-transparent"
				>
					<option value="">Select a team member</option>
					{users.map((u) => (
						<option key={u.email} value={u.email}>
							{u.name} ({u.email})
						</option>
					))}
				</select>
			</div>

			{/* Empty state: no member selected */}
			{!assigneeFilter && (
				<div className="flex flex-col items-center justify-center py-24 text-center">
					<svg
						className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
						/>
					</svg>
					<p className="text-gray-500 dark:text-gray-400">Select a team member to see their tasks.</p>
				</div>
			)}

			{/* Empty state: member selected but no tasks */}
			{assigneeFilter && assignedTasks.length === 0 && (
				<div className="flex flex-col items-center justify-center py-24 text-center">
					<svg
						className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
					>
						<path
							strokeLinecap="round"
							strokeLinejoin="round"
							strokeWidth={1.5}
							d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
						/>
					</svg>
					<p className="text-gray-500 dark:text-gray-400">
						No tasks assigned to {selectedUser?.name ?? assigneeFilter}.
					</p>
				</div>
			)}

			{/* Task count summary */}
			{assigneeFilter && assignedTasks.length > 0 && (
				<p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
					{assignedTasks.length} task{assignedTasks.length === 1 ? "" : "s"} assigned to{" "}
					{selectedUser?.name ?? assigneeFilter}
				</p>
			)}

			{/* Milestone groups */}
			{groups.length > 0 && (
				<div className="space-y-4">
					{groups.map((group) => {
						const isCollapsed = collapsedGroups[group.key] ?? false;
						return (
							<div
								key={group.key}
								className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden"
							>
								<div
									className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
									onClick={() => toggleGroup(group.key)}
								>
									<div className="flex items-center gap-3">
										<svg
											className={`w-4 h-4 text-gray-400 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
										</svg>
										<h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
											{group.label}
										</h2>
										<span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
											{group.tasks.length}
										</span>
									</div>
								</div>

								{!isCollapsed && (
									<div className="border-t border-gray-200 dark:border-gray-700">
										<div className="grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
											<div className="w-6" />
											<div className="w-24">ID</div>
											<div>Title</div>
											<div className="text-center w-24">Status</div>
											<div className="text-center w-20">Priority</div>
										</div>
										<div className="divide-y divide-gray-200 dark:divide-gray-700">
											{group.tasks.map((task) => (
												<MilestoneTaskRow
													key={task.id}
													task={task}
													isDone={isDoneStatus(task.status)}
													statusBadgeClass={getStatusBadgeClass(task.status)}
													priorityBadgeClass={getPriorityBadgeClass(task.priority)}
													onEditTask={onEditTask}
													onDragStart={noop}
													onDragEnd={noop}
												/>
											))}
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
};

export default TeamPage;
```

**Step 2: Check that `apiClient` has a `fetchUsers` method**

Open `src/web/lib/api.ts` and search for `fetchUsers`. If it doesn't exist, add it (see Task 2 below).

**Step 3: Verify TypeScript compiles**

```bash
bunx tsc --noEmit
```

Expected: no errors related to `TeamPage.tsx`.

---

### Task 2: Add `fetchUsers` to `apiClient` (only if missing)

**Files:**
- Modify: `src/web/lib/api.ts`

**Step 1: Check if it already exists**

```bash
grep -n "fetchUsers" src/web/lib/api.ts
```

If it exists, skip this task entirely.

**Step 2: Add the method**

Find the section where other `fetch*` methods live in `src/web/lib/api.ts` and add:

```typescript
async fetchUsers(): Promise<{ email: string; name: string }[]> {
    const response = await fetch("/api/users");
    if (!response.ok) return [];
    return response.json();
},
```

**Step 3: Verify TypeScript**

```bash
bunx tsc --noEmit
```

Expected: no errors.

---

### Task 3: Add routes in `App.tsx`

**Files:**
- Modify: `src/web/App.tsx`

Three changes in this file:

**Step 1: Import `TeamPage`**

At the top of `App.tsx` with the other page imports (around line 10), add:

```typescript
import TeamPage from './components/TeamPage';
```

**Step 2: Fix `handleCloseModal` to handle `/team/:taskId`**

Current code at line 270:
```typescript
if (!window.location.pathname.match(/^\/tasks\/.+/)) return;
```

Change to:
```typescript
if (!window.location.pathname.match(/^\/(tasks|team)\/.+/)) return;
```

This allows the modal to close correctly when navigated from `/team/:taskId`.

**Step 3: Add `/team` and `/team/:taskId` routes**

Inside the `<Routes>` block, after the `my-work` route (around line 436), add:

```tsx
<Route
  path="team"
  element={
    <TeamPage
      tasks={tasks}
      milestoneEntities={milestoneEntities}
      onEditTask={handleEditTask}
    />
  }
/>
<Route
  path="team/:taskId"
  element={
    <TaskRoute
      tasks={tasks}
      isLoading={isLoading}
      onOpen={handleOpenTaskFromRoute}
    />
  }
/>
```

**Step 4: Verify TypeScript**

```bash
bunx tsc --noEmit
```

Expected: no errors.

---

### Task 4: Add "Team" nav item to `SideNavigation.tsx`

**Files:**
- Modify: `src/web/components/SideNavigation.tsx`

Two changes: expanded sidebar and collapsed sidebar icon.

**Step 1: Add the `Team` icon to the `Icons` object**

After `Icons.MyWork` definition (around line 134), add:

```typescript
Team: () => (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
),
```

**Step 2: Add the expanded nav link**

In the expanded navigation section, after the "My Work" `NavLink` (around line 544) and before "Milestones", add:

```tsx
{/* Team Navigation */}
<NavLink
    to="/team"
    className={({ isActive }) =>
        `flex items-center px-3 py-2 rounded-lg transition-colors duration-200 ${
            isActive
                ? 'bg-blue-50 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 font-medium'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
        }`
    }
>
    <Icons.Team />
    <span className="ml-3 text-sm font-medium">Team</span>
</NavLink>
```

**Step 3: Add the collapsed icon**

In the collapsed sidebar section (around line 733, near "Milestones" collapsed icon), add before the Milestones `NavLink`:

```tsx
<NavLink
    to="/team"
    data-tooltip-id="sidebar-tooltip"
    data-tooltip-content="Team"
    className={({ isActive }) =>
        `flex items-center justify-center p-3 rounded-md transition-colors duration-200 ${
            isActive
                ? 'bg-blue-50 dark:bg-blue-600/20 text-blue-700 dark:text-blue-400'
                : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-900 dark:hover:text-gray-100'
        }`
    }
>
    <div className="w-6 h-6 flex items-center justify-center">
        <Icons.Team />
    </div>
</NavLink>
```

**Step 4: Verify TypeScript**

```bash
bunx tsc --noEmit
```

Expected: no errors.

---

### Task 5: Final verification

**Step 1: Full type check**

```bash
bunx tsc --noEmit
```

Expected: 0 errors.

**Step 2: Lint check**

```bash
bun run check src/web/components/TeamPage.tsx src/web/components/SideNavigation.tsx src/web/App.tsx
```

Expected: no errors (fix any lint issues before committing).

**Step 3: Build**

```bash
bun run build
```

Expected: build succeeds with no errors.

**Step 4: Commit**

```bash
git add src/web/components/TeamPage.tsx src/web/components/SideNavigation.tsx src/web/App.tsx src/web/lib/api.ts
git commit -m "Add Team page for browsing tasks by assignee"
```
