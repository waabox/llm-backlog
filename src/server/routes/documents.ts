import type { Core } from "../../core/backlog.ts";

export async function handleListDocs(core: Core): Promise<Response> {
	try {
		const store = await core.getContentStore();
		const docs = store.getDocuments();
		const docFiles = docs.map((doc) => ({
			name: `${doc.title}.md`,
			id: doc.id,
			title: doc.title,
			type: doc.type,
			createdDate: doc.createdDate,
			updatedDate: doc.updatedDate,
			lastModified: doc.updatedDate || doc.createdDate,
			tags: doc.tags || [],
		}));
		return Response.json(docFiles);
	} catch (error) {
		console.error("Error listing documents:", error);
		return Response.json([]);
	}
}

export async function handleGetDoc(docId: string, core: Core): Promise<Response> {
	try {
		const doc = await core.getDocument(docId);
		if (!doc) {
			return Response.json({ error: "Document not found" }, { status: 404 });
		}
		return Response.json(doc);
	} catch (error) {
		console.error("Error loading document:", error);
		return Response.json({ error: "Document not found" }, { status: 404 });
	}
}

export async function handleCreateDoc(req: Request, core: Core): Promise<Response> {
	const { filename, content } = await req.json();

	try {
		const title = filename.replace(".md", "");
		const document = await core.createDocumentWithId(title, content);
		return Response.json({ success: true, id: document.id }, { status: 201 });
	} catch (error) {
		console.error("Error creating document:", error);
		return Response.json({ error: "Failed to create document" }, { status: 500 });
	}
}

export async function handleUpdateDoc(req: Request, docId: string, core: Core): Promise<Response> {
	try {
		const body = await req.json();
		const content = typeof body?.content === "string" ? body.content : undefined;
		const title = typeof body?.title === "string" ? body.title : undefined;

		if (typeof content !== "string") {
			return Response.json({ error: "Document content is required" }, { status: 400 });
		}

		let normalizedTitle: string | undefined;

		if (typeof title === "string") {
			normalizedTitle = title.trim();
			if (normalizedTitle.length === 0) {
				return Response.json({ error: "Document title cannot be empty" }, { status: 400 });
			}
		}

		const existingDoc = await core.getDocument(docId);
		if (!existingDoc) {
			return Response.json({ error: "Document not found" }, { status: 404 });
		}

		const nextDoc = normalizedTitle ? { ...existingDoc, title: normalizedTitle } : { ...existingDoc };

		await core.updateDocument(nextDoc, content);
		return Response.json({ success: true });
	} catch (error) {
		console.error("Error updating document:", error);
		if (error instanceof SyntaxError) {
			return Response.json({ error: "Invalid request payload" }, { status: 400 });
		}
		return Response.json({ error: "Failed to update document" }, { status: 500 });
	}
}
