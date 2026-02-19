import { unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDecision } from "../markdown/parser.ts";
import { serializeDecision } from "../markdown/serializer.ts";
import type { Decision } from "../types/index.ts";
import { sortByTaskId } from "../utils/task-sorting.ts";
import { ensureDirectoryExists, sanitizeFilename } from "./shared.ts";

export class DecisionStore {
	private readonly decisionsDir: string;

	constructor(decisionsDir: string) {
		this.decisionsDir = decisionsDir;
	}

	async saveDecision(decision: Decision): Promise<void> {
		// Normalize ID - remove "decision-" prefix if present
		const normalizedId = decision.id.replace(/^decision-/, "");
		const filename = `decision-${normalizedId} - ${sanitizeFilename(decision.title)}.md`;
		const filepath = join(this.decisionsDir, filename);
		const content = serializeDecision(decision);

		const matches = await Array.fromAsync(
			new Bun.Glob("decision-*.md").scan({ cwd: this.decisionsDir, followSymlinks: true }),
		);
		for (const match of matches) {
			if (match === filename) continue;
			if (!match.startsWith(`decision-${normalizedId} -`)) continue;
			try {
				await unlink(join(this.decisionsDir, match));
			} catch {
				// Ignore cleanup errors
			}
		}

		await ensureDirectoryExists(dirname(filepath));
		await Bun.write(filepath, content);
	}

	async loadDecision(decisionId: string): Promise<Decision | null> {
		try {
			const files = await Array.fromAsync(
				new Bun.Glob("decision-*.md").scan({ cwd: this.decisionsDir, followSymlinks: true }),
			);

			// Normalize ID - remove "decision-" prefix if present
			const normalizedId = decisionId.replace(/^decision-/, "");
			const decisionFile = files.find((file) => file.startsWith(`decision-${normalizedId} -`));

			if (!decisionFile) return null;

			const filepath = join(this.decisionsDir, decisionFile);
			const content = await Bun.file(filepath).text();
			return parseDecision(content);
		} catch (_error) {
			return null;
		}
	}

	async listDecisions(): Promise<Decision[]> {
		try {
			const decisionFiles = await Array.fromAsync(
				new Bun.Glob("decision-*.md").scan({ cwd: this.decisionsDir, followSymlinks: true }),
			);
			const decisions: Decision[] = [];
			for (const file of decisionFiles) {
				// Filter out README files as they're just instruction files
				if (file.toLowerCase().match(/^readme\.md$/i)) {
					continue;
				}
				const filepath = join(this.decisionsDir, file);
				const content = await Bun.file(filepath).text();
				decisions.push(parseDecision(content));
			}
			return sortByTaskId(decisions);
		} catch {
			return [];
		}
	}
}
