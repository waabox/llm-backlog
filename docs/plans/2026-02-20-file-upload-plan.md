# File Upload & Asset Viewer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow users to upload files as task attachments via the Web UI, view image thumbnails inline in the task detail, and open a lightbox for full preview.

**Architecture:** A new `AssetStore` class handles deterministic bucket-based storage under `backlog/assets/<bucket>/<taskId>/`. Three new REST endpoints (list, upload, delete) are wired into the existing server. The frontend adds a `TaskAttachments` section to `TaskDetailsModal` with drag-and-drop upload, thumbnail grid, and a lightbox component. Static serving of `/assets/*` already exists in the server — no changes needed for that.

**Tech Stack:** Bun, TypeScript, React (no React Query — use useState + useEffect), Tailwind CSS, existing `apiClient` / raw `fetch` for multipart.

---

### Task 1: Add ASSETS constant

**Files:**
- Modify: `src/constants/index.ts`

**Step 1: Add the constant**

In `DEFAULT_DIRECTORIES`, add the `ASSETS` entry after `MILESTONES`:

```ts
MILESTONES: "milestones",
ASSETS: "assets",
```

**Step 2: Verify TypeScript is happy**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 3: Commit**

```bash
git add src/constants/index.ts
git commit -m "Add ASSETS directory constant"
```

---

### Task 2: Create AssetStore

**Files:**
- Create: `src/file-system/asset-store.ts`

**Step 1: Write the file**

```ts
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ensureDirectoryExists } from "./shared.ts";

export interface AssetMetadata {
	filename: string;
	originalName: string;
	mimeType: string;
	size: number;
	url: string;
	isImage: boolean;
}

const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif"]);

const MIME_MAP: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	svg: "image/svg+xml",
	webp: "image/webp",
	avif: "image/avif",
	pdf: "application/pdf",
	txt: "text/plain",
};

function mimeForExt(ext: string): string {
	return MIME_MAP[ext.toLowerCase()] ?? "application/octet-stream";
}

export class AssetStore {
	private readonly assetsDir: string;

	constructor(assetsDir: string) {
		this.assetsDir = assetsDir;
	}

	getBucket(taskId: string): string {
		const match = taskId.match(/\d+/);
		const num = match ? parseInt(match[0], 10) : 0;
		return Math.floor(num / 100).toString().padStart(3, "0");
	}

	getTaskDir(taskId: string): string {
		return join(this.assetsDir, this.getBucket(taskId), taskId);
	}

	async saveAsset(taskId: string, originalFilename: string, buffer: ArrayBuffer): Promise<AssetMetadata> {
		const dir = this.getTaskDir(taskId);
		await ensureDirectoryExists(dir);

		const ext = extname(originalFilename).slice(1).toLowerCase();
		const base = basename(originalFilename, extname(originalFilename))
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		const filename = `${Date.now()}-${base}${ext ? `.${ext}` : ""}`;
		const filePath = join(dir, filename);

		await writeFile(filePath, Buffer.from(buffer));

		const bucket = this.getBucket(taskId);
		return {
			filename,
			originalName: originalFilename,
			mimeType: mimeForExt(ext),
			size: buffer.byteLength,
			url: `/assets/${bucket}/${taskId}/${filename}`,
			isImage: IMAGE_EXTS.has(ext),
		};
	}

	async listAssets(taskId: string): Promise<AssetMetadata[]> {
		const dir = this.getTaskDir(taskId);
		const bucket = this.getBucket(taskId);

		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return [];
		}

		const results: AssetMetadata[] = [];
		for (const filename of names.sort()) {
			const ext = extname(filename).slice(1).toLowerCase();
			// Strip leading timestamp prefix to recover approximate original name
			const originalName = filename.replace(/^\d+-/, "");
			let size = 0;
			try {
				const s = await stat(join(dir, filename));
				size = s.size;
			} catch {
				// ignore
			}
			results.push({
				filename,
				originalName,
				mimeType: mimeForExt(ext),
				size,
				url: `/assets/${bucket}/${taskId}/${filename}`,
				isImage: IMAGE_EXTS.has(ext),
			});
		}
		return results;
	}

	async deleteAsset(taskId: string, filename: string): Promise<void> {
		// Prevent path traversal
		if (filename.includes("/") || filename.includes("..")) {
			throw new Error("Invalid filename");
		}
		const filePath = join(this.getTaskDir(taskId), filename);
		await unlink(filePath);
	}

	getAssetPath(taskId: string, filename: string): string {
		return join(this.getTaskDir(taskId), filename);
	}
}
```

**Step 2: Type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 3: Commit**

```bash
git add src/file-system/asset-store.ts
git commit -m "Add AssetStore with bucketed file storage"
```

---

### Task 3: Expose AssetStore in FileSystem

**Files:**
- Modify: `src/file-system/operations.ts`

**Step 1: Import and instantiate AssetStore**

At the top of `operations.ts`, add the import:

```ts
import { AssetStore } from "./asset-store.ts";
```

In the `FileSystem` class body, add a private field after `private readonly milestoneStore`:

```ts
private readonly assetStore: AssetStore;
```

In the constructor, after `milestoneStore` initialization, add:

```ts
this.assetStore = new AssetStore(join(this.backlogDir, DEFAULT_DIRECTORIES.ASSETS));
```

**Step 2: Add public getter and delegate methods**

After the existing getters (`get docsDir`, etc.), add:

```ts
get assetsDir(): string {
	return join(this.backlogDir, DEFAULT_DIRECTORIES.ASSETS);
}

get assets(): AssetStore {
	return this.assetStore;
}
```

**Step 3: Type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 4: Commit**

```bash
git add src/file-system/operations.ts
git commit -m "Expose AssetStore in FileSystem"
```

---

### Task 4: Create asset route handlers

**Files:**
- Create: `src/server/routes/assets.ts`

**Step 1: Write the handlers**

```ts
import type { Core } from "../../core/backlog.ts";

export async function handleListAssets(taskId: string, core: Core): Promise<Response> {
	try {
		const assets = await core.filesystem.assets.listAssets(taskId);
		return Response.json(assets);
	} catch (error) {
		console.error("Error listing assets:", error);
		return Response.json({ error: "Failed to list assets" }, { status: 500 });
	}
}

export async function handleUploadAsset(req: Request, taskId: string, core: Core): Promise<Response> {
	try {
		const formData = await req.formData();
		const file = formData.get("file");
		if (!file || !(file instanceof File)) {
			return Response.json({ error: "No file provided" }, { status: 400 });
		}

		const buffer = await file.arrayBuffer();
		const metadata = await core.filesystem.assets.saveAsset(taskId, file.name, buffer);

		// Commit the new file to git
		const config = await core.filesystem.loadConfig();
		if (config?.autoCommit) {
			const filePath = core.filesystem.assets.getAssetPath(taskId, metadata.filename);
			await core.git.commitFiles(`Add asset ${metadata.originalName} to ${taskId}`, [filePath]);
		}

		return Response.json(metadata, { status: 201 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Upload failed";
		console.error("Error uploading asset:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleDeleteAsset(taskId: string, filename: string, core: Core): Promise<Response> {
	try {
		const filePath = core.filesystem.assets.getAssetPath(taskId, filename);
		await core.filesystem.assets.deleteAsset(taskId, filename);

		// Commit the deletion to git
		const config = await core.filesystem.loadConfig();
		if (config?.autoCommit) {
			await core.git.commitFiles(`Remove asset ${filename} from ${taskId}`, [filePath]);
		}

		return Response.json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Delete failed";
		console.error("Error deleting asset:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}
```

**Step 2: Type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 3: Commit**

```bash
git add src/server/routes/assets.ts
git commit -m "Add asset route handlers for list, upload, delete"
```

---

### Task 5: Wire asset routes into BacklogServer

**Files:**
- Modify: `src/server/index.ts`

**Step 1: Add import at top of server imports block**

Find the existing route imports (around line 14-50) and add:

```ts
import { handleDeleteAsset, handleListAssets, handleUploadAsset } from "./routes/assets.ts";
```

**Step 2: Add routes to the server routes object**

Find the routes block in `start()`. After the `/api/tasks/:id/complete` entry, add:

```ts
"/api/tasks/:id/assets": {
    GET: this.protect(async (_req: Request, params: Record<string, string>) =>
        await handleListAssets(params.id ?? "", this.core)
    ),
    POST: this.protect(async (req: Request, params: Record<string, string>) =>
        await handleUploadAsset(req, params.id ?? "", this.core)
    ),
},
"/api/tasks/:id/assets/:filename": {
    DELETE: this.protect(async (_req: Request, params: Record<string, string>) =>
        await handleDeleteAsset(params.id ?? "", params.filename ?? "", this.core)
    ),
},
```

**Note on route params:** Look at how existing routes extract path params — for example around line 237-248. Adjust the handler signature to match the actual Bun route API used in the project. If params aren't passed directly, check how `handleGetTask` extracts `:id` and follow the same pattern.

**Step 3: Type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 4: Start the server and smoke-test manually**

```bash
bun run cli -- serve .
```

In another terminal:
```bash
curl -s http://localhost:6420/api/tasks/task-1/assets
```
Expected: `[]` (empty array, no error).

**Step 5: Commit**

```bash
git add src/server/index.ts
git commit -m "Wire asset endpoints into BacklogServer"
```

---

### Task 6: Integration tests for asset endpoints

**Files:**
- Modify: `src/test/integration.test.ts`

**Step 1: Find where to add tests**

Open `src/test/integration.test.ts`. Find an existing test block (e.g., the task CRUD tests). Add a new `describe` block for asset endpoints in the same file.

**Step 2: Write the tests**

Add this block after existing task tests:

```ts
describe("Asset endpoints", () => {
    it("lists empty assets for a task", async () => {
        const res = await fetch(`${baseUrl}/api/tasks/task-1/assets`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Array.isArray(body)).toBe(true);
    });

    it("uploads a file and lists it back", async () => {
        const form = new FormData();
        form.append("file", new File(["hello world"], "test.txt", { type: "text/plain" }));

        const uploadRes = await fetch(`${baseUrl}/api/tasks/task-1/assets`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
        });
        expect(uploadRes.status).toBe(201);
        const asset = await uploadRes.json();
        expect(asset.filename).toMatch(/\d+-test\.txt/);
        expect(asset.mimeType).toBe("text/plain");
        expect(asset.url).toMatch(/^\/assets\/000\/task-1\//);

        const listRes = await fetch(`${baseUrl}/api/tasks/task-1/assets`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const list = await listRes.json();
        expect(list.length).toBe(1);
        expect(list[0].filename).toBe(asset.filename);
    });

    it("deletes an uploaded asset", async () => {
        // Upload first
        const form = new FormData();
        form.append("file", new File(["data"], "to-delete.txt", { type: "text/plain" }));
        const uploadRes = await fetch(`${baseUrl}/api/tasks/task-1/assets`, {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}` },
            body: form,
        });
        const asset = await uploadRes.json();

        // Delete
        const delRes = await fetch(`${baseUrl}/api/tasks/task-1/assets/${encodeURIComponent(asset.filename)}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        expect(delRes.status).toBe(200);

        // List should be empty again
        const listRes = await fetch(`${baseUrl}/api/tasks/task-1/assets`, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const list = await listRes.json();
        expect(list.every((a: { filename: string }) => a.filename !== asset.filename)).toBe(true);
    });
});
```

**Note:** Check the test file for the exact variable names used for `baseUrl` and `apiKey` — match those exactly.

**Step 3: Run tests**

```bash
CLAUDECODE=1 bun test src/test/integration.test.ts
```
Expected: all asset tests pass.

**Step 4: Commit**

```bash
git add src/test/integration.test.ts
git commit -m "Add integration tests for asset endpoints"
```

---

### Task 7: Create useTaskAssets hook

**Files:**
- Create: `src/web/hooks/useTaskAssets.ts`

**Step 1: Write the hook**

```ts
import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "../lib/api";

export interface AssetMetadata {
	filename: string;
	originalName: string;
	mimeType: string;
	size: number;
	url: string;
	isImage: boolean;
}

export function useTaskAssets(taskId: string | undefined) {
	const [assets, setAssets] = useState<AssetMetadata[]>([]);
	const [loading, setLoading] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const authHeader = (): Record<string, string> => {
		const token = ApiClient.getToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	};

	const fetchAssets = useCallback(async () => {
		if (!taskId) return;
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/tasks/${taskId}/assets`, {
				headers: authHeader(),
			});
			if (!res.ok) throw new Error(`Failed to load assets: ${res.status}`);
			const data: AssetMetadata[] = await res.json();
			setAssets(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load assets");
		} finally {
			setLoading(false);
		}
	}, [taskId]);

	useEffect(() => {
		fetchAssets();
	}, [fetchAssets]);

	const uploadAsset = useCallback(async (file: File): Promise<void> => {
		if (!taskId) return;
		setUploading(true);
		setError(null);
		try {
			const form = new FormData();
			form.append("file", file);
			const res = await fetch(`/api/tasks/${taskId}/assets`, {
				method: "POST",
				headers: authHeader(),
				body: form,
			});
			if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
			await fetchAssets();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploading(false);
		}
	}, [taskId, fetchAssets]);

	const deleteAsset = useCallback(async (filename: string): Promise<void> => {
		if (!taskId) return;
		setError(null);
		try {
			const res = await fetch(`/api/tasks/${taskId}/assets/${encodeURIComponent(filename)}`, {
				method: "DELETE",
				headers: authHeader(),
			});
			if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
			setAssets((prev) => prev.filter((a) => a.filename !== filename));
		} catch (err) {
			setError(err instanceof Error ? err.message : "Delete failed");
		}
	}, [taskId]);

	return { assets, loading, uploading, error, uploadAsset, deleteAsset, refetch: fetchAssets };
}
```

**Step 2: Type-check**

```bash
bunx tsc --noEmit
```
Expected: no errors.

**Step 3: Commit**

```bash
git add src/web/hooks/useTaskAssets.ts
git commit -m "Add useTaskAssets hook for file upload/list/delete"
```

---

### Task 8: Create AssetLightbox component

**Files:**
- Create: `src/web/components/AssetLightbox.tsx`

**Step 1: Write the component**

```tsx
import React, { useEffect } from "react";
import type { AssetMetadata } from "../hooks/useTaskAssets";

interface Props {
	asset: AssetMetadata;
	onClose: () => void;
}

export const AssetLightbox: React.FC<Props> = ({ asset, onClose }) => {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
			onClick={onClose}
		>
			<div
				className="relative max-w-4xl max-h-screen p-4 flex flex-col items-center"
				onClick={(e) => e.stopPropagation()}
			>
				<img
					src={asset.url}
					alt={asset.originalName}
					className="max-h-[80vh] max-w-full object-contain rounded shadow-lg"
				/>
				<div className="mt-3 flex items-center gap-4">
					<span className="text-white text-sm">{asset.originalName}</span>
					<a
						href={asset.url}
						target="_blank"
						rel="noopener noreferrer"
						className="px-3 py-1 text-sm bg-white text-gray-900 rounded hover:bg-gray-100 transition-colors"
					>
						Full-Size
					</a>
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1 text-sm bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors"
					>
						Close
					</button>
				</div>
			</div>
		</div>
	);
};
```

**Step 2: Type-check**

```bash
bunx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/web/components/AssetLightbox.tsx
git commit -m "Add AssetLightbox component"
```

---

### Task 9: Create TaskAttachments component

**Files:**
- Create: `src/web/components/TaskAttachments.tsx`

**Step 1: Write the component**

```tsx
import React, { useCallback, useRef, useState } from "react";
import type { AssetMetadata } from "../hooks/useTaskAssets";
import { useTaskAssets } from "../hooks/useTaskAssets";
import { AssetLightbox } from "./AssetLightbox";

const FILE_ICONS: Record<string, string> = {
	pdf: "📄",
	zip: "🗜️",
	tar: "🗜️",
	gz: "🗜️",
	doc: "📝",
	docx: "📝",
	xls: "📊",
	xlsx: "📊",
	mp4: "🎬",
	mov: "🎬",
	mp3: "🎵",
};

function fileIcon(ext: string): string {
	return FILE_ICONS[ext.toLowerCase()] ?? "📎";
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
	taskId: string;
}

export const TaskAttachments: React.FC<Props> = ({ taskId }) => {
	const { assets, loading, uploading, error, uploadAsset, deleteAsset } = useTaskAssets(taskId);
	const [lightboxAsset, setLightboxAsset] = useState<AssetMetadata | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const handleFiles = useCallback(
		async (files: FileList | null) => {
			if (!files) return;
			for (const file of Array.from(files)) {
				await uploadAsset(file);
			}
		},
		[uploadAsset],
	);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragOver(false);
			handleFiles(e.dataTransfer.files);
		},
		[handleFiles],
	);

	const onDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(true);
	};

	const onDragLeave = () => setDragOver(false);

	return (
		<div>
			{/* Upload zone */}
			<div
				onDrop={onDrop}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				className={`border-2 border-dashed rounded-md p-4 text-center cursor-pointer transition-colors ${
					dragOver
						? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
						: "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
				}`}
				onClick={() => inputRef.current?.click()}
			>
				<input
					ref={inputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => handleFiles(e.target.files)}
				/>
				{uploading ? (
					<span className="text-sm text-gray-500 dark:text-gray-400">Uploading...</span>
				) : (
					<span className="text-sm text-gray-500 dark:text-gray-400">
						Drop files here or <span className="text-blue-500">click to upload</span>
					</span>
				)}
			</div>

			{error && (
				<p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
			)}

			{/* Asset grid */}
			{loading ? (
				<p className="mt-3 text-sm text-gray-400">Loading attachments...</p>
			) : assets.length > 0 ? (
				<div className="mt-3 flex flex-wrap gap-3">
					{assets.map((asset) => (
						<div
							key={asset.filename}
							className="group relative flex flex-col items-center gap-1"
						>
							{asset.isImage ? (
								<button
									type="button"
									onClick={() => setLightboxAsset(asset)}
									className="block w-24 h-24 rounded overflow-hidden border border-gray-200 dark:border-gray-700 hover:border-blue-400 transition-colors"
								>
									<img
										src={asset.url}
										alt={asset.originalName}
										className="w-full h-full object-cover"
									/>
								</button>
							) : (
								<a
									href={asset.url}
									target="_blank"
									rel="noopener noreferrer"
									className="flex flex-col items-center justify-center w-24 h-24 rounded border border-gray-200 dark:border-gray-700 hover:border-blue-400 transition-colors text-3xl bg-gray-50 dark:bg-gray-800"
								>
									{fileIcon(asset.originalName.split(".").pop() ?? "")}
								</a>
							)}
							<span
								className="text-xs text-gray-500 dark:text-gray-400 max-w-[96px] truncate text-center"
								title={asset.originalName}
							>
								{asset.originalName}
							</span>
							<span className="text-xs text-gray-400">{formatBytes(asset.size)}</span>
							<button
								type="button"
								onClick={() => deleteAsset(asset.filename)}
								className="absolute -top-1 -right-1 hidden group-hover:flex w-5 h-5 items-center justify-center rounded-full bg-red-500 text-white text-xs leading-none"
								title="Remove"
							>
								×
							</button>
						</div>
					))}
				</div>
			) : null}

			{lightboxAsset && (
				<AssetLightbox asset={lightboxAsset} onClose={() => setLightboxAsset(null)} />
			)}
		</div>
	);
};
```

**Step 2: Type-check**

```bash
bunx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/web/components/TaskAttachments.tsx
git commit -m "Add TaskAttachments component with drag-and-drop and lightbox"
```

---

### Task 10: Wire TaskAttachments into TaskDetailsModal

**Files:**
- Modify: `src/web/components/TaskDetailsModal.tsx`

**Step 1: Add import at the top of the file**

After the existing imports, add:

```tsx
import { TaskAttachments } from "./TaskAttachments";
```

**Step 2: Find insertion point**

Search for the `References` section block (around line 563). The attachments section should appear **after** References and **before** the Documentation section (around line 640).

**Step 3: Add the section**

After the closing `</div>` of the References section, add:

```tsx
{/* Attachments */}
{task && !isFromOtherBranch && (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
        <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
                Attachments
            </h3>
        </div>
        <TaskAttachments taskId={task.id} />
    </div>
)}
```

**Note:** `isFromOtherBranch` is a boolean derived from task metadata — check how it's computed in the file (grep for `isFromOtherBranch`) and use the same variable.

**Step 4: Type-check and lint**

```bash
bunx tsc --noEmit
bun run check src/web/components/TaskDetailsModal.tsx
```

**Step 5: Manual smoke test**

```bash
bun run cli -- serve .
```

Open a task in the Web UI. Verify:
- "Attachments" section appears below References
- Upload zone is shown
- Drag a file or click to upload
- Image files show as thumbnails; click → lightbox opens
- Non-image files show as file icon with link
- Hover over an asset → red × button appears; click to delete

**Step 6: Commit**

```bash
git add src/web/components/TaskDetailsModal.tsx
git commit -m "Add Attachments section to TaskDetailsModal"
```

---

## Done

At this point:
- `backlog/assets/<bucket>/<task-id>/<timestamp>-<name>.<ext>` stores uploaded files
- GET/POST/DELETE `/api/tasks/:id/assets` endpoints work and are tested
- `/assets/*` static serving already worked before this feature
- The Web UI shows thumbnails, lightbox, drag-and-drop upload, and delete
- Files are committed to git when `auto_commit: true`
