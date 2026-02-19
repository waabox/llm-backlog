import { join } from "node:path";
import { DEFAULT_DIRECTORIES } from "../constants/index.ts";
import type { Decision, Document } from "../types/index.ts";
import { documentIdsEqual } from "../utils/document-id.ts";
import type { Core } from "./backlog.ts";

export async function createDecision(core: Core, decision: Decision, autoCommit?: boolean): Promise<void> {
	await core.fs.saveDecision(decision);

	if (await core.shouldAutoCommit(autoCommit)) {
		const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
		await core.git.commitChanges(`backlog: Add decision ${decision.id}`, repoRoot);
	}
}

export async function updateDecisionFromContent(
	core: Core,
	decisionId: string,
	content: string,
	autoCommit?: boolean,
): Promise<void> {
	const existingDecision = await core.fs.loadDecision(decisionId);
	if (!existingDecision) {
		throw new Error(`Decision ${decisionId} not found`);
	}

	// Parse the markdown content to extract the decision data
	const matter = await import("gray-matter");
	const { data } = matter.default(content);

	const extractSection = (content: string, sectionName: string): string | undefined => {
		const regex = new RegExp(`## ${sectionName}\\s*([\\s\\S]*?)(?=## |$)`, "i");
		const match = content.match(regex);
		return match ? match[1]?.trim() : undefined;
	};

	const updatedDecision = {
		...existingDecision,
		title: data.title || existingDecision.title,
		status: data.status || existingDecision.status,
		date: data.date || existingDecision.date,
		context: extractSection(content, "Context") || existingDecision.context,
		decision: extractSection(content, "Decision") || existingDecision.decision,
		consequences: extractSection(content, "Consequences") || existingDecision.consequences,
		alternatives: extractSection(content, "Alternatives") || existingDecision.alternatives,
	};

	await createDecision(core, updatedDecision, autoCommit);
}

export async function createDecisionWithTitle(core: Core, title: string, autoCommit?: boolean): Promise<Decision> {
	const { generateNextDecisionId } = await import("../utils/id-generators.js");
	const id = await generateNextDecisionId(core);

	const decision: Decision = {
		id,
		title,
		date: new Date().toISOString().slice(0, 16).replace("T", " "),
		status: "proposed",
		context: "[Describe the context and problem that needs to be addressed]",
		decision: "[Describe the decision that was made]",
		consequences: "[Describe the consequences of this decision]",
		rawContent: "",
	};

	await createDecision(core, decision, autoCommit);
	return decision;
}

export async function createDocument(core: Core, doc: Document, autoCommit?: boolean, subPath = ""): Promise<void> {
	const relativePath = await core.fs.saveDocument(doc, subPath);
	doc.path = relativePath;

	if (await core.shouldAutoCommit(autoCommit)) {
		const repoRoot = await core.git.stageBacklogDirectory(DEFAULT_DIRECTORIES.BACKLOG);
		await core.git.commitChanges(`backlog: Add document ${doc.id}`, repoRoot);
	}
}

export async function updateDocument(
	core: Core,
	existingDoc: Document,
	content: string,
	autoCommit?: boolean,
): Promise<void> {
	const updatedDoc = {
		...existingDoc,
		rawContent: content,
		updatedDate: new Date().toISOString().slice(0, 16).replace("T", " "),
	};

	let normalizedSubPath = "";
	if (existingDoc.path) {
		const segments = existingDoc.path.split(/[\\/]/).slice(0, -1);
		if (segments.length > 0) {
			normalizedSubPath = segments.join("/");
		}
	}

	await createDocument(core, updatedDoc, autoCommit, normalizedSubPath);
}

export async function createDocumentWithId(
	core: Core,
	title: string,
	content: string,
	autoCommit?: boolean,
): Promise<Document> {
	const { generateNextDocId } = await import("../utils/id-generators.js");
	const id = await generateNextDocId(core);

	const document: Document = {
		id,
		title,
		type: "other" as const,
		createdDate: new Date().toISOString().slice(0, 16).replace("T", " "),
		rawContent: content,
	};

	await createDocument(core, document, autoCommit);
	return document;
}

export async function getDocument(core: Core, documentId: string): Promise<Document | null> {
	const documents = await core.fs.listDocuments();
	const match = documents.find((doc) => documentIdsEqual(documentId, doc.id));
	return match ?? null;
}

export async function getDocumentContent(core: Core, documentId: string): Promise<string | null> {
	const document = await getDocument(core, documentId);
	if (!document) return null;

	const relativePath = document.path ?? `${document.id}.md`;
	const filePath = join(core.fs.docsDir, relativePath);
	try {
		return await Bun.file(filePath).text();
	} catch {
		return null;
	}
}
