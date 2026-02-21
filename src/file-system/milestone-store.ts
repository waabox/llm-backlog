import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseMilestone } from "../markdown/parser.ts";
import type { Milestone } from "../types/index.ts";
import { ensureDirectoryExists } from "./shared.ts";

export class MilestoneStore {
	private readonly milestonesDir: string;
	private readonly archiveMilestonesDir: string;

	constructor(milestonesDir: string, archiveMilestonesDir: string) {
		this.milestonesDir = milestonesDir;
		this.archiveMilestonesDir = archiveMilestonesDir;
	}

	async listMilestones(): Promise<Milestone[]> {
		try {
			const milestoneFiles = await Array.fromAsync(
				new Bun.Glob("m-*.md").scan({ cwd: this.milestonesDir, followSymlinks: true }),
			);
			const milestones: Milestone[] = [];
			for (const file of milestoneFiles) {
				// Filter out README files
				if (file.toLowerCase() === "readme.md") {
					continue;
				}
				const filepath = join(this.milestonesDir, file);
				const content = await Bun.file(filepath).text();
				milestones.push(parseMilestone(content));
			}
			// Sort by ID for consistent ordering
			return milestones.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
		} catch {
			return [];
		}
	}

	async listArchivedMilestones(): Promise<Milestone[]> {
		try {
			const milestoneFiles = await Array.fromAsync(
				new Bun.Glob("m-*.md").scan({ cwd: this.archiveMilestonesDir, followSymlinks: true }),
			);
			const milestones: Milestone[] = [];
			for (const file of milestoneFiles) {
				if (file.toLowerCase() === "readme.md") {
					continue;
				}
				const filepath = join(this.archiveMilestonesDir, file);
				const content = await Bun.file(filepath).text();
				milestones.push(parseMilestone(content));
			}
			return milestones.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
		} catch {
			return [];
		}
	}

	async loadMilestone(id: string): Promise<Milestone | null> {
		try {
			const milestoneMatch = await this.findMilestoneFile(id, "active");
			return milestoneMatch?.milestone ?? null;
		} catch (_error) {
			return null;
		}
	}

	async createMilestone(title: string, description?: string): Promise<Milestone> {
		// Ensure milestones directory exists
		await mkdir(this.milestonesDir, { recursive: true });

		// Find next available milestone ID
		await mkdir(this.archiveMilestonesDir, { recursive: true });
		const [existingFiles, archivedFiles] = await Promise.all([
			Array.fromAsync(new Bun.Glob("m-*.md").scan({ cwd: this.milestonesDir, followSymlinks: true })),
			Array.fromAsync(new Bun.Glob("m-*.md").scan({ cwd: this.archiveMilestonesDir, followSymlinks: true })),
		]);
		const parseMilestoneId = async (dir: string, file: string): Promise<number | null> => {
			if (file.toLowerCase() === "readme.md") {
				return null;
			}
			const filepath = join(dir, file);
			try {
				const content = await Bun.file(filepath).text();
				const parsed = parseMilestone(content);
				const parsedIdMatch = parsed.id.match(/^m-(\d+)$/i);
				if (parsedIdMatch?.[1]) {
					return Number.parseInt(parsedIdMatch[1], 10);
				}
			} catch {
				// Fall through to filename-based fallback.
			}
			const filenameIdMatch = file.match(/^m-(\d+)/i);
			if (filenameIdMatch?.[1]) {
				return Number.parseInt(filenameIdMatch[1], 10);
			}
			return null;
		};
		const existingIds = (
			await Promise.all([
				...existingFiles.map((file) => parseMilestoneId(this.milestonesDir, file)),
				...archivedFiles.map((file) => parseMilestoneId(this.archiveMilestonesDir, file)),
			])
		).filter((id): id is number => typeof id === "number" && id >= 0);

		const nextId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 0;
		const id = `m-${nextId}`;

		const filename = this.buildMilestoneFilename(id, title);
		const content = this.serializeMilestoneContent(
			id,
			title,
			`## Description

${description || `Milestone: ${title}`}`,
		);

		const filepath = join(this.milestonesDir, filename);
		await Bun.write(filepath, content);

		return {
			id,
			title,
			description: description || `Milestone: ${title}`,
			active: false,
			rawContent: parseMilestone(content).rawContent,
		};
	}

	async renameMilestone(
		identifier: string,
		title: string,
	): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		milestone?: Milestone;
		previousTitle?: string;
	}> {
		const normalizedTitle = title.trim();
		if (!normalizedTitle) {
			return { success: false };
		}

		let sourcePath: string | undefined;
		let targetPath: string | undefined;
		let movedFile = false;
		let originalContent: string | undefined;

		try {
			const milestoneMatch = await this.findMilestoneFile(identifier, "active");
			if (!milestoneMatch) {
				return { success: false };
			}

			const { milestone } = milestoneMatch;
			const targetFilename = this.buildMilestoneFilename(milestone.id, normalizedTitle);
			targetPath = join(this.milestonesDir, targetFilename);
			sourcePath = milestoneMatch.filepath;
			originalContent = milestoneMatch.content;
			const nextRawContent = this.rewriteDefaultMilestoneDescription(
				milestone.rawContent,
				milestone.title,
				normalizedTitle,
			);
			const updatedContent = this.serializeMilestoneContent(milestone.id, normalizedTitle, nextRawContent);

			if (sourcePath !== targetPath) {
				if (await Bun.file(targetPath).exists()) {
					return { success: false };
				}
				await rename(sourcePath, targetPath);
				movedFile = true;
			}
			await Bun.write(targetPath, updatedContent);

			return {
				success: true,
				sourcePath,
				targetPath,
				milestone: parseMilestone(updatedContent),
				previousTitle: milestone.title,
			};
		} catch {
			try {
				if (movedFile && sourcePath && targetPath && sourcePath !== targetPath) {
					await rename(targetPath, sourcePath);
					if (originalContent) {
						await Bun.write(sourcePath, originalContent);
					}
				} else if (originalContent) {
					const restorePath = sourcePath ?? targetPath;
					if (restorePath) {
						await Bun.write(restorePath, originalContent);
					}
				}
			} catch {
				// Ignore rollback failures and surface operation failure to caller.
			}
			return { success: false };
		}
	}

	async archiveMilestone(identifier: string): Promise<{
		success: boolean;
		sourcePath?: string;
		targetPath?: string;
		milestone?: Milestone;
	}> {
		const normalized = identifier.trim();
		if (!normalized) {
			return { success: false };
		}

		try {
			const milestoneMatch = await this.findMilestoneFile(normalized, "active");
			if (!milestoneMatch) {
				return { success: false };
			}

			const targetPath = join(this.archiveMilestonesDir, milestoneMatch.file);
			await ensureDirectoryExists(dirname(targetPath));
			await rename(milestoneMatch.filepath, targetPath);

			return {
				success: true,
				sourcePath: milestoneMatch.filepath,
				targetPath,
				milestone: milestoneMatch.milestone,
			};
		} catch (_error) {
			return { success: false };
		}
	}

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

	private buildMilestoneIdentifierKeys(identifier: string): Set<string> {
		const normalized = identifier.trim().toLowerCase();
		const keys = new Set<string>();
		if (!normalized) {
			return keys;
		}

		keys.add(normalized);

		if (/^\d+$/.test(normalized)) {
			const numeric = String(Number.parseInt(normalized, 10));
			keys.add(numeric);
			keys.add(`m-${numeric}`);
			return keys;
		}

		const milestoneIdMatch = normalized.match(/^m-(\d+)$/);
		if (milestoneIdMatch?.[1]) {
			const numeric = String(Number.parseInt(milestoneIdMatch[1], 10));
			keys.add(numeric);
			keys.add(`m-${numeric}`);
		}

		return keys;
	}

	private buildMilestoneFilename(id: string, title: string): string {
		const safeTitle = title
			.replace(/[<>:"/\\|?*]/g, "")
			.replace(/\s+/g, "-")
			.toLowerCase()
			.slice(0, 50);
		return `${id} - ${safeTitle}.md`;
	}

	private serializeMilestoneContent(id: string, title: string, rawContent: string, active = false): string {
		return `---
id: ${id}
title: "${title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"
active: ${active}
---

${rawContent.trim()}
`;
	}

	private rewriteDefaultMilestoneDescription(rawContent: string, previousTitle: string, nextTitle: string): string {
		const defaultDescription = `Milestone: ${previousTitle}`;
		const descriptionSectionPattern = /(##\s+Description\s*(?:\r?\n)+)([\s\S]*?)(?=(?:\r?\n)##\s+|$)/i;

		return rawContent.replace(descriptionSectionPattern, (fullSection, heading: string, body: string) => {
			if (body.trim() !== defaultDescription) {
				return fullSection;
			}
			const trailingWhitespace = body.match(/\s*$/)?.[0] ?? "";
			return `${heading}Milestone: ${nextTitle}${trailingWhitespace}`;
		});
	}

	private async findMilestoneFile(
		identifier: string,
		scope: "active" | "archived" = "active",
	): Promise<{
		file: string;
		filepath: string;
		content: string;
		milestone: Milestone;
	} | null> {
		const normalizedInput = identifier.trim().toLowerCase();
		const candidateKeys = this.buildMilestoneIdentifierKeys(identifier);
		if (candidateKeys.size === 0) {
			return null;
		}
		const variantKeys = new Set<string>(candidateKeys);
		variantKeys.delete(normalizedInput);
		const canonicalInputId =
			/^\d+$/.test(normalizedInput) || /^m-\d+$/.test(normalizedInput)
				? `m-${String(Number.parseInt(normalizedInput.replace(/^m-/, ""), 10))}`
				: null;

		const dir = scope === "archived" ? this.archiveMilestonesDir : this.milestonesDir;
		const milestoneFiles = await Array.fromAsync(new Bun.Glob("m-*.md").scan({ cwd: dir, followSymlinks: true }));

		const rawExactIdMatches: Array<{ file: string; filepath: string; content: string; milestone: Milestone }> = [];
		const canonicalRawIdMatches: Array<{ file: string; filepath: string; content: string; milestone: Milestone }> = [];
		const exactAliasIdMatches: Array<{ file: string; filepath: string; content: string; milestone: Milestone }> = [];
		const exactTitleMatches: Array<{ file: string; filepath: string; content: string; milestone: Milestone }> = [];
		const variantIdMatches: Array<{ file: string; filepath: string; content: string; milestone: Milestone }> = [];
		const variantTitleMatches: Array<{ file: string; filepath: string; content: string; milestone: Milestone }> = [];

		for (const file of milestoneFiles) {
			if (file.toLowerCase() === "readme.md") {
				continue;
			}
			const filepath = join(dir, file);
			const content = await Bun.file(filepath).text();
			let milestone: Milestone;
			try {
				milestone = parseMilestone(content);
			} catch {
				continue;
			}
			const idKey = milestone.id.trim().toLowerCase();
			const idKeys = this.buildMilestoneIdentifierKeys(milestone.id);
			const titleKey = milestone.title.trim().toLowerCase();

			if (idKey === normalizedInput) {
				rawExactIdMatches.push({ file, filepath, content, milestone });
				continue;
			}
			if (canonicalInputId && idKey === canonicalInputId) {
				canonicalRawIdMatches.push({ file, filepath, content, milestone });
				continue;
			}
			if (idKeys.has(normalizedInput)) {
				exactAliasIdMatches.push({ file, filepath, content, milestone });
				continue;
			}
			if (titleKey === normalizedInput) {
				exactTitleMatches.push({ file, filepath, content, milestone });
				continue;
			}
			if (Array.from(idKeys).some((key) => variantKeys.has(key))) {
				variantIdMatches.push({ file, filepath, content, milestone });
				continue;
			}
			if (variantKeys.has(titleKey)) {
				variantTitleMatches.push({ file, filepath, content, milestone });
			}
		}

		const preferIdMatches = /^\d+$/.test(normalizedInput) || /^m-\d+$/.test(normalizedInput);
		const exactTitleMatch = exactTitleMatches.length === 1 ? exactTitleMatches[0] : null;
		const variantTitleMatch = variantTitleMatches.length === 1 ? variantTitleMatches[0] : null;
		const exactAliasIdMatch = exactAliasIdMatches.length === 1 ? exactAliasIdMatches[0] : null;
		const variantIdMatch = variantIdMatches.length === 1 ? variantIdMatches[0] : null;
		if (preferIdMatches) {
			return (
				rawExactIdMatches[0] ??
				canonicalRawIdMatches[0] ??
				exactAliasIdMatch ??
				variantIdMatch ??
				exactTitleMatch ??
				variantTitleMatch ??
				null
			);
		}
		return (
			rawExactIdMatches[0] ?? exactTitleMatch ?? canonicalRawIdMatches[0] ?? variantIdMatch ?? variantTitleMatch ?? null
		);
	}
}
