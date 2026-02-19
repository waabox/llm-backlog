import { join } from "node:path";
import type { Command } from "commander";
import { Core } from "../core/backlog.ts";
import type { Document as DocType } from "../types/index.ts";
import { genericSelectList } from "../ui/components/generic-list.ts";
import { scrollableViewer } from "../ui/tui.ts";
import { generateNextDocId } from "../utils/id-generators.ts";
import { isPlainRequested, requireProjectRoot } from "./shared.ts";

/**
 * Register the doc command group for creating, listing, and viewing documents.
 *
 * @param program - Commander program instance
 */
export function registerDocCommand(program: Command): void {
	const shouldAutoPlain = !(process.stdout.isTTY && process.stdin.isTTY);

	const docCmd = program.command("doc");

	docCmd
		.command("create <title>")
		.option("-p, --path <path>")
		.option("-t, --type <type>")
		.action(async (title: string, options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const id = await generateNextDocId(core);
			const document: DocType = {
				id,
				title: title as string,
				type: (options.type || "other") as DocType["type"],
				createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
				rawContent: "",
			};
			await core.createDocument(document, undefined, options.path || "");
			console.log(`Created document ${id}`);
		});

	docCmd
		.command("list")
		.option("--plain", "use plain text output instead of interactive UI")
		.action(async (options) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			const docs = await core.filesystem.listDocuments();
			if (docs.length === 0) {
				console.log("No docs found.");
				return;
			}

			// Plain text output for non-interactive environments
			const usePlainOutput = isPlainRequested(options) || shouldAutoPlain;
			if (usePlainOutput) {
				for (const d of docs) {
					console.log(`${d.id} - ${d.title}`);
				}
				return;
			}

			// Interactive UI
			const selected = await genericSelectList("Select a document", docs);
			if (selected) {
				// Show document details (recursive search)
				const files = await Array.fromAsync(
					new Bun.Glob("**/*.md").scan({ cwd: core.filesystem.docsDir, followSymlinks: true }),
				);
				const docFile = files.find(
					(f) => f.startsWith(`${selected.id} -`) || f.endsWith(`/${selected.id}.md`) || f === `${selected.id}.md`,
				);
				if (docFile) {
					const filePath = join(core.filesystem.docsDir, docFile);
					const content = await Bun.file(filePath).text();
					await scrollableViewer(content);
				}
			}
		});

	// Document view command
	docCmd
		.command("view <docId>")
		.description("view a document")
		.action(async (docId: string) => {
			const cwd = await requireProjectRoot();
			const core = new Core(cwd);
			try {
				const content = await core.getDocumentContent(docId);
				if (content === null) {
					console.error(`Document ${docId} not found.`);
					return;
				}
				await scrollableViewer(content);
			} catch {
				console.error(`Document ${docId} not found.`);
			}
		});
}
