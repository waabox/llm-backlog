import { rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "../markdown/parser.ts";
import { serializeDocument } from "../markdown/serializer.ts";
import type { Document } from "../types/index.ts";
import { documentIdsEqual, normalizeDocumentId } from "../utils/document-id.ts";
import { ensureDirectoryExists, sanitizeFilename } from "./shared.ts";

export class DocumentStore {
	private readonly docsDir: string;

	constructor(docsDir: string) {
		this.docsDir = docsDir;
	}

	async saveDocument(document: Document, subPath = ""): Promise<string> {
		const canonicalId = normalizeDocumentId(document.id);
		document.id = canonicalId;
		const filename = `${canonicalId} - ${sanitizeFilename(document.title)}.md`;
		const subPathSegments = subPath
			.split(/[\\/]+/)
			.map((segment) => segment.trim())
			.filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
		const relativePath = subPathSegments.length > 0 ? join(...subPathSegments, filename) : filename;
		const filepath = join(this.docsDir, relativePath);
		const content = serializeDocument(document);

		await ensureDirectoryExists(dirname(filepath));

		const glob = new Bun.Glob("**/doc-*.md");
		const existingMatches = await Array.fromAsync(glob.scan({ cwd: this.docsDir, followSymlinks: true }));
		const matchesForId = existingMatches.filter((relative) => {
			const base = relative.split("/").pop() || relative;
			const [candidateId] = base.split(" - ");
			if (!candidateId) return false;
			return documentIdsEqual(canonicalId, candidateId);
		});

		let sourceRelativePath = document.path;
		if (!sourceRelativePath && matchesForId.length > 0) {
			sourceRelativePath = matchesForId[0];
		}

		if (sourceRelativePath && sourceRelativePath !== relativePath) {
			const sourcePath = join(this.docsDir, sourceRelativePath);
			try {
				await ensureDirectoryExists(dirname(filepath));
				await rename(sourcePath, filepath);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException | undefined)?.code;
				if (code !== "ENOENT") {
					throw error;
				}
			}
		}

		for (const match of matchesForId) {
			const matchPath = join(this.docsDir, match);
			if (matchPath === filepath) {
				continue;
			}
			try {
				await unlink(matchPath);
			} catch {
				// Ignore cleanup errors - file may have been removed already
			}
		}

		await Bun.write(filepath, content);

		document.path = relativePath;
		return relativePath;
	}

	async listDocuments(): Promise<Document[]> {
		try {
			// Recursively include all markdown files under docs, excluding README.md variants
			const glob = new Bun.Glob("**/*.md");
			const docFiles = await Array.fromAsync(glob.scan({ cwd: this.docsDir, followSymlinks: true }));
			const docs: Document[] = [];
			for (const file of docFiles) {
				const base = file.split("/").pop() || file;
				if (base.toLowerCase() === "readme.md") continue;
				const filepath = join(this.docsDir, file);
				const content = await Bun.file(filepath).text();
				const parsed = parseDocument(content);
				docs.push({
					...parsed,
					path: file,
				});
			}

			// Stable sort by title for UI/CLI listing
			return docs.sort((a, b) => a.title.localeCompare(b.title));
		} catch {
			return [];
		}
	}

	async loadDocument(id: string): Promise<Document> {
		const documents = await this.listDocuments();
		const document = documents.find((doc) => documentIdsEqual(id, doc.id));
		if (!document) {
			throw new Error(`Document not found: ${id}`);
		}
		return document;
	}
}
