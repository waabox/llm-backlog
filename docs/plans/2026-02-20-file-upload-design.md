# File Upload & Asset Viewer Design

**Date:** 2026-02-20
**Status:** Approved

## Overview

Allow users to upload files as attachments to tasks via the Web UI. Files are stored on disk under `backlog/assets/`, committed to git, and viewable inline in the task detail with a thumbnail grid and lightbox popup.

## Storage

### Directory structure

```
backlog/assets/
  001/
    task-123/
      1708123456789-diagrama.png
      1708123456800-spec.pdf
  002/
    task-234/
      1708123456900-screenshot.jpg
```

### Bucketing (deterministic numeric)

```ts
bucket = Math.floor(extractNumericId(taskId) / 100).toString().padStart(3, '0')
```

- task-001 to task-099 → `000/`
- task-100 to task-199 → `001/`
- Deterministic: given a taskId, the bucket path is always known without scanning the filesystem.

### File naming

`<Date.now()>-<sanitizedOriginalName>.<ext>`

Example: `1708123456789-system-diagram.png`

### Metadata

Derived at runtime from the file path — no extra JSON index file.

```ts
interface AssetMetadata {
  filename: string      // stored name: "1708123456789-diagrama.png"
  originalName: string  // "diagrama.png"
  mimeType: string
  size: number
  url: string           // "/api/assets/001/task-123/1708123456789-diagrama.png"
  isImage: boolean
}
```

### Git

Assets are committed to git after save and delete, respecting the project's `auto_commit` config setting.

## Backend

### New endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/tasks/:id/assets` | Upload file (multipart/form-data) |
| `GET` | `/api/tasks/:id/assets` | List assets for a task |
| `DELETE` | `/api/tasks/:id/assets/:filename` | Delete a specific asset |
| `GET` | `/api/assets/:bucket/:taskId/:filename` | Serve file (static) |

### New module: `src/file-system/asset-store.ts`

```ts
class AssetStore {
  saveAsset(taskId: string, file: File): Promise<AssetMetadata>
  listAssets(taskId: string): Promise<AssetMetadata[]>
  deleteAsset(taskId: string, filename: string): Promise<void>
  getAssetPath(taskId: string, filename: string): string
  getBucket(taskId: string): string
}
```

### New route: `src/server/routes/assets.ts`

Handlers for the 4 endpoints above. Registered in `BacklogServer`.

## Frontend

### New components

- **`src/web/components/TaskAttachments.tsx`** — embedded in `TaskDetailsModal`. Contains:
  - Drag & drop zone + file picker button
  - Grid of asset thumbnails (images) or generic file icons (other types)
  - Click on image → opens `AssetLightbox`
  - Click on non-image → opens file in new browser tab

- **`src/web/components/AssetLightbox.tsx`** — modal overlay with:
  - Centered image display
  - "Full-Size" button → `window.open(url, '_blank')`
  - Close on click-outside or ESC key

### New hook: `src/web/hooks/useTaskAssets.ts`

React Query hook covering list, upload, and delete. Query key: `['assets', taskId]`.

### Thumbnail rendering

- **Images:** `<img src="..." style="max-width:120px; max-height:120px; object-fit:cover" />`
- **Other files:** generic icon based on file extension (PDF, ZIP, DOC, etc.)

### Integration point

`TaskAttachments` is added as a new section inside `TaskDetailsModal.tsx`, below the existing task body content.

## Constraints

- Upload is Web UI only (no CLI support).
- Any file type accepted on upload.
- No file size limit enforced at the application level (OS/disk is the limit).
- Assets directory: `backlog/assets/` — added to `DEFAULT_DIRECTORIES` constant.
