import type { Core } from "../../core/backlog.ts";

export async function handleListDecisions(core: Core): Promise<Response> {
	try {
		const store = await core.getContentStore();
		const decisions = store.getDecisions();
		const decisionFiles = decisions.map((decision) => ({
			id: decision.id,
			title: decision.title,
			status: decision.status,
			date: decision.date,
			context: decision.context,
			decision: decision.decision,
			consequences: decision.consequences,
			alternatives: decision.alternatives,
		}));
		return Response.json(decisionFiles);
	} catch (error) {
		console.error("Error listing decisions:", error);
		return Response.json([]);
	}
}

export async function handleGetDecision(decisionId: string, core: Core): Promise<Response> {
	try {
		const store = await core.getContentStore();
		const normalizedId = decisionId.startsWith("decision-") ? decisionId : `decision-${decisionId}`;
		const decision = store.getDecisions().find((item) => item.id === normalizedId || item.id === decisionId);

		if (!decision) {
			return Response.json({ error: "Decision not found" }, { status: 404 });
		}

		return Response.json(decision);
	} catch (error) {
		console.error("Error loading decision:", error);
		return Response.json({ error: "Decision not found" }, { status: 404 });
	}
}

export async function handleCreateDecision(req: Request, core: Core): Promise<Response> {
	const { title } = await req.json();

	try {
		const decision = await core.createDecisionWithTitle(title);
		return Response.json(decision, { status: 201 });
	} catch (error) {
		console.error("Error creating decision:", error);
		return Response.json({ error: "Failed to create decision" }, { status: 500 });
	}
}

export async function handleUpdateDecision(req: Request, decisionId: string, core: Core): Promise<Response> {
	const content = await req.text();

	try {
		await core.updateDecisionFromContent(decisionId, content);
		return Response.json({ success: true });
	} catch (error) {
		if (error instanceof Error && error.message.includes("not found")) {
			return Response.json({ error: "Decision not found" }, { status: 404 });
		}
		console.error("Error updating decision:", error);
		return Response.json({ error: "Failed to update decision" }, { status: 500 });
	}
}
