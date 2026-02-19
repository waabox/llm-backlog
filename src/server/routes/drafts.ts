import type { Core } from "../../core/backlog.ts";

export async function handleListDrafts(core: Core): Promise<Response> {
	try {
		const drafts = await core.filesystem.listDrafts();
		return Response.json(drafts);
	} catch (error) {
		console.error("Error listing drafts:", error);
		return Response.json([]);
	}
}

export async function handlePromoteDraft(draftId: string, core: Core): Promise<Response> {
	try {
		const success = await core.promoteDraft(draftId);
		if (!success) {
			return Response.json({ error: "Draft not found" }, { status: 404 });
		}
		return Response.json({ success: true });
	} catch (error) {
		console.error("Error promoting draft:", error);
		return Response.json({ error: "Failed to promote draft" }, { status: 500 });
	}
}
