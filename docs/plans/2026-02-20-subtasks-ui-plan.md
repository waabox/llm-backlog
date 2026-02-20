# Subtasks UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a "Subtasks" section to `TaskDetailsModal` that lists subtasks and lets users create new ones.

**Architecture:** Fetch subtasks on modal open via existing `GET /api/tasks?parent=<id>` endpoint. Two new optional props (`onOpenTask`, `onAddSubtask`) let App.tsx coordinate modal navigation. `pendingParentTaskId` in App.tsx threads the parent ID into task creation.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, existing `apiClient.fetchTasks`

---

### Task 1: Add subtask state and fetch to `TaskDetailsModal`

**Files:**
- Modify: `src/web/components/TaskDetailsModal.tsx`

**Step 1: Add the two new props to the `Props` interface**

In `src/web/components/TaskDetailsModal.tsx`, find the `Props` interface (line 17) and add two fields after `definitionOfDoneDefaults`:

```typescript
onOpenTask?: (task: Task) => void;   // click a subtask row to navigate to it
onAddSubtask?: (parentId: string) => void; // click "+ Add" to create a subtask
```

**Step 2: Destructure the new props in the component function**

Find the destructuring at line 54 (`export const TaskDetailsModal: React.FC<Props> = ({`) and add `onOpenTask` and `onAddSubtask` to the destructured list.

**Step 3: Add `subtasks` state**

After the existing `const [error, setError] = useState<string | null>(null);` line (around line 72), add:

```typescript
const [subtasks, setSubtasks] = useState<Task[]>([]);
```

**Step 4: Fetch subtasks in the existing reset `useEffect`**

Find the `useEffect` that fires on `[task, isOpen]` — it resets all state when the modal opens/closes. At the end of this effect (before the closing `}`), add a subtask fetch:

```typescript
if (task && (task.subtaskSummaries?.length ?? 0) > 0) {
  apiClient.fetchTasks({ parent: task.id })
    .then(setSubtasks)
    .catch(() => setSubtasks([]));
} else {
  setSubtasks([]);
}
```

**Step 5: Run type check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 6: Commit**

```bash
git add src/web/components/TaskDetailsModal.tsx
git commit -m "feat(ui): add subtask state and fetch to TaskDetailsModal"
```

---

### Task 2: Render the Subtasks section

**Files:**
- Modify: `src/web/components/TaskDetailsModal.tsx`

**Step 1: Add a local `getStatusColor` helper**

Inside the component function body (just before the `return`), add:

```typescript
const getSubtaskStatusColor = (status: string): string => {
  switch (status.toLowerCase()) {
    case "to do":       return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
    case "in progress": return "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200";
    case "done":        return "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200";
    default:            return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
  }
};
```

**Step 2: Insert the Subtasks section between Description and References**

The Description section ends at line 563 (`</div>`) and References starts at line 565. Insert between them:

```tsx
{/* Subtasks — only for existing tasks that are not from another branch */}
{!isCreateMode && !isFromOtherBranch && (
  <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
    <SectionHeader
      title="Subtasks"
      right={
        <button
          onClick={() => task && onAddSubtask?.(task.id)}
          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add
        </button>
      }
    />
    {subtasks.length > 0 ? (
      <ul
        className="space-y-1 overflow-y-auto"
        style={{ maxHeight: "11rem" /* ~5 rows of 2rem each */ }}
      >
        {subtasks.map((sub) => (
          <li
            key={sub.id}
            onClick={() => onOpenTask?.(sub)}
            className="flex items-center gap-3 px-2 py-1.5 rounded-md cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
          >
            <code className="text-xs font-mono text-gray-400 dark:text-gray-500 shrink-0">{sub.id}</code>
            <span className="flex-1 text-sm text-gray-900 dark:text-gray-100 truncate">{sub.title}</span>
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full shrink-0 ${getSubtaskStatusColor(sub.status ?? "")}`}>
              {sub.status}
            </span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-sm text-gray-500 dark:text-gray-400">No subtasks</p>
    )}
  </div>
)}
```

**Step 3: Run type check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 4: Run tests**

```bash
CLAUDECODE=1 bun test
```

Expected: 118 tests pass, no failures.

**Step 5: Commit**

```bash
git add src/web/components/TaskDetailsModal.tsx
git commit -m "feat(ui): render Subtasks section in TaskDetailsModal"
```

---

### Task 3: Wire subtask props in `App.tsx`

**Files:**
- Modify: `src/web/App.tsx`

**Step 1: Add `pendingParentTaskId` state**

In `AppRoutes()`, find the block with `showModal` and `editingTask` state declarations (line 53–54). Add directly after them:

```typescript
const [pendingParentTaskId, setPendingParentTaskId] = useState<string | null>(null);
```

**Step 2: Add `handleOpenTask` handler**

After `handleNewTask` (around line 255), add:

```typescript
const handleOpenTask = useCallback((task: Task) => {
  setEditingTask(task);
  setShowModal(true);
}, []);
```

**Step 3: Add `handleAddSubtask` handler**

Add directly after `handleOpenTask`:

```typescript
const handleAddSubtask = useCallback((parentId: string) => {
  setPendingParentTaskId(parentId);
  setEditingTask(null);
  setShowModal(true);
}, []);
```

**Step 4: Update `handleSubmitTask` to include `parentTaskId`**

Find `handleSubmitTask` (line 310). In the `else` branch (create path), after `await apiClient.createTask(...)` is built but before the call, include `parentTaskId` when set:

```typescript
const createData = pendingParentTaskId
  ? { ...taskData, parentTaskId: pendingParentTaskId }
  : taskData;
const createdTask = await apiClient.createTask(createData as Omit<Task, "id" | "createdDate">);
```

(Replace the existing `apiClient.createTask(taskData as ...)` line with the two lines above.)

**Step 5: Clear `pendingParentTaskId` on close**

Find `handleCloseModal` (line 261). Add `setPendingParentTaskId(null);` alongside `setEditingTask(null);`.

**Step 6: Pass new props to `<TaskDetailsModal>`**

Find the `<TaskDetailsModal` JSX (line 494) and add:

```tsx
onOpenTask={handleOpenTask}
onAddSubtask={handleAddSubtask}
```

**Step 7: Run type check**

```bash
bunx tsc --noEmit
```

Expected: no errors.

**Step 8: Run tests**

```bash
CLAUDECODE=1 bun test
```

Expected: 118 tests pass, no failures.

**Step 9: Commit**

```bash
git add src/web/App.tsx
git commit -m "feat(ui): wire subtask open/add handlers in App"
```

---

### Task 4: E2E smoke test

**Goal:** Manually verify the feature works end-to-end in the browser.

**Step 1: Start the dev server pointing at a backlog directory that has a parent task with subtasks**

```bash
bun run cli serve /path/to/your-project
```

Or use the existing test fixture by running:

```bash
bun run cli serve /tmp/test-subtasks
```

If using a fresh directory, create a parent task and a subtask:

```bash
bun run cli task create -t "Parent task" -d /tmp/e2e-smoke
bun run cli task create -t "Sub task one" --parent BACK-1 -d /tmp/e2e-smoke
```

**Step 2: Open the browser and navigate to the parent task**

Open the parent task (e.g., BACK-1) in the task modal.

**Expected:** "Subtasks" section is visible below Description. It lists "BACK-1.1 | Sub task one | To Do".

**Step 3: Click a subtask row**

**Expected:** Modal updates to show the subtask details.

**Step 4: Navigate back to the parent and click "+ Add"**

**Expected:** Modal switches to create mode (empty title field, no subtask list). Fill in a title and click "Create". Task is created as a subtask of the parent.

**Step 5: Confirm**

Reopen the parent task.

**Expected:** Both subtasks appear in the Subtasks section.
