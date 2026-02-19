import type { Core } from "../../core/backlog.ts";

export async function handleGetSequences(core: Core): Promise<Response> {
	const data = await core.listActiveSequences();
	return Response.json(data);
}

export async function handleMoveSequence(req: Request, core: Core): Promise<Response> {
	try {
		const body = await req.json();
		const taskId = String(body.taskId || "").trim();
		const moveToUnsequenced = Boolean(body.unsequenced === true);
		const targetSequenceIndex = body.targetSequenceIndex !== undefined ? Number(body.targetSequenceIndex) : undefined;

		if (!taskId) return Response.json({ error: "taskId is required" }, { status: 400 });

		const next = await core.moveTaskInSequences({
			taskId,
			unsequenced: moveToUnsequenced,
			targetSequenceIndex,
		});
		return Response.json(next);
	} catch (error) {
		const message = (error as Error)?.message || "Invalid request";
		return Response.json({ error: message }, { status: 400 });
	}
}
