import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
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
		const num = match ? Number.parseInt(match[0], 10) : 0;
		return Math.floor(num / 100)
			.toString()
			.padStart(3, "0");
	}

	getTaskDir(taskId: string): string {
		return join(this.assetsDir, this.getBucket(taskId), taskId);
	}

	async saveAsset(taskId: string, originalFilename: string, buffer: ArrayBuffer): Promise<AssetMetadata> {
		const dir = this.getTaskDir(taskId);
		await ensureDirectoryExists(dir);

		const ext = extname(originalFilename).slice(1).toLowerCase();
		const base = originalFilename
			.replace(/\.[^.]+$/, "")
			.replace(/[^a-zA-Z0-9._-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "");
		const filename = `${Date.now()}-${base}${ext ? `.${ext}` : ""}`;
		const filePath = join(dir, filename);

		await writeFile(filePath, Buffer.from(buffer));

		return {
			filename,
			originalName: originalFilename,
			mimeType: mimeForExt(ext),
			size: buffer.byteLength,
			url: `/assets/${this.getBucket(taskId)}/${taskId}/${filename}`,
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
			const originalName = filename.replace(/^\d+-/, "");
			let size = 0;
			try {
				const s = await stat(join(dir, filename));
				size = s.size;
			} catch {
				// ignore stat errors
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
