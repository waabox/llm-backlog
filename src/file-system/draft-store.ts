import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseTask } from "../markdown/parser.ts";
import { serializeTask } from "../markdown/serializer.ts";
import type { Task } from "../types/index.ts";
import { buildGlobPattern, idForFilename, normalizeId } from "../utils/prefix-config.ts";
import { normalizeTaskIdentity } from "../utils/task-path.ts";
import { sortByTaskId } from "../utils/task-sorting.ts";
import { ensureDirectoryExists, sanitizeFilename } from "./shared.ts";

export class DraftStore {
	private readonly draftsDir: string;
	private readonly archiveDraftsDir: string;

	constructor(draftsDir: string, archiveDraftsDir: string) {
		this.draftsDir = draftsDir;
		this.archiveDraftsDir = archiveDraftsDir;
	}

	async saveDraft(task: Task): Promise<string> {
		const draftId = normalizeId(task.id, "draft");
		const filename = `${idForFilename(draftId)} - ${sanitizeFilename(task.title)}.md`;
		const filepath = join(this.draftsDir, filename);
		// Normalize the draft ID to uppercase before serialization
		const normalizedTask = { ...task, id: draftId };
		const content = serializeTask(normalizedTask);

		try {
			// Find existing draft file with same ID but possibly different filename (e.g., title changed)
			const filenameId = idForFilename(draftId);
			const existingFiles = await Array.fromAsync(
				new Bun.Glob(buildGlobPattern("draft")).scan({ cwd: this.draftsDir, followSymlinks: true }),
			);
			const existingFile = existingFiles.find((f) => f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`));
			if (existingFile && existingFile !== filename) {
				await unlink(join(this.draftsDir, existingFile));
			}
		} catch {
			// Ignore errors if no existing files found
		}

		await ensureDirectoryExists(dirname(filepath));
		await Bun.write(filepath, content);
		return filepath;
	}

	async loadDraft(draftId: string): Promise<Task | null> {
		try {
			// Search for draft files with draft- prefix
			const files = await Array.fromAsync(
				new Bun.Glob(buildGlobPattern("draft")).scan({ cwd: this.draftsDir, followSymlinks: true }),
			);
			const normalizedId = normalizeId(draftId, "draft");
			const filenameId = idForFilename(normalizedId);

			// Find matching draft file
			const draftFile = files.find((f) => f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`));
			if (!draftFile) return null;

			const filepath = join(this.draftsDir, draftFile);
			const content = await Bun.file(filepath).text();
			const task = normalizeTaskIdentity(parseTask(content));
			return { ...task, filePath: filepath };
		} catch {
			return null;
		}
	}

	async listDrafts(): Promise<Task[]> {
		try {
			const taskFiles = await Array.fromAsync(
				new Bun.Glob(buildGlobPattern("draft")).scan({ cwd: this.draftsDir, followSymlinks: true }),
			);

			const tasks: Task[] = [];
			for (const file of taskFiles) {
				const filepath = join(this.draftsDir, file);
				const content = await Bun.file(filepath).text();
				const task = normalizeTaskIdentity(parseTask(content));
				tasks.push({ ...task, filePath: filepath });
			}

			return sortByTaskId(tasks);
		} catch {
			return [];
		}
	}

	async archiveDraft(draftId: string): Promise<boolean> {
		try {
			// Find draft file with draft- prefix
			const files = await Array.fromAsync(
				new Bun.Glob(buildGlobPattern("draft")).scan({ cwd: this.draftsDir, followSymlinks: true }),
			);
			const normalizedId = normalizeId(draftId, "draft");
			const filenameId = idForFilename(normalizedId);
			const draftFile = files.find((f) => f.startsWith(`${filenameId} -`) || f.startsWith(`${filenameId}-`));

			if (!draftFile) return false;

			const sourcePath = join(this.draftsDir, draftFile);
			const targetPath = join(this.archiveDraftsDir, draftFile);

			const content = await Bun.file(sourcePath).text();
			await ensureDirectoryExists(dirname(targetPath));
			await Bun.write(targetPath, content);

			await unlink(sourcePath);

			return true;
		} catch {
			return false;
		}
	}
}
