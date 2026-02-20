import type { Core } from "../../core/backlog.ts";

export async function handleListMilestones(core: Core): Promise<Response> {
	try {
		const milestones = await core.filesystem.listMilestones();
		return Response.json(milestones);
	} catch (error) {
		console.error("Error listing milestones:", error);
		return Response.json([]);
	}
}

export async function handleListArchivedMilestones(core: Core): Promise<Response> {
	try {
		const milestones = await core.filesystem.listArchivedMilestones();
		return Response.json(milestones);
	} catch (error) {
		console.error("Error listing archived milestones:", error);
		return Response.json([]);
	}
}

export async function handleGetMilestone(milestoneId: string, core: Core): Promise<Response> {
	try {
		const milestone = await core.filesystem.loadMilestone(milestoneId);
		if (!milestone) {
			return Response.json({ error: "Milestone not found" }, { status: 404 });
		}
		return Response.json(milestone);
	} catch (error) {
		console.error("Error loading milestone:", error);
		return Response.json({ error: "Milestone not found" }, { status: 404 });
	}
}

export async function handleCreateMilestone(req: Request, core: Core): Promise<Response> {
	try {
		const body = (await req.json()) as { title?: string; description?: string };
		const title = body.title?.trim();

		if (!title) {
			return Response.json({ error: "Milestone title is required" }, { status: 400 });
		}

		// Check for duplicates
		const existingMilestones = await core.filesystem.listMilestones();
		const buildAliasKeys = (value: string): Set<string> => {
			const normalized = value.trim().toLowerCase();
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
			const match = normalized.match(/^m-(\d+)$/);
			if (match?.[1]) {
				const numeric = String(Number.parseInt(match[1], 10));
				keys.add(numeric);
				keys.add(`m-${numeric}`);
			}
			return keys;
		};
		const requestedKeys = buildAliasKeys(title);
		const duplicate = existingMilestones.find((milestone) => {
			const milestoneKeys = new Set<string>([...buildAliasKeys(milestone.id), ...buildAliasKeys(milestone.title)]);
			for (const key of requestedKeys) {
				if (milestoneKeys.has(key)) {
					return true;
				}
			}
			return false;
		});
		if (duplicate) {
			return Response.json({ error: "A milestone with this title or ID already exists" }, { status: 400 });
		}

		const milestone = await core.createMilestone(title, body.description);
		return Response.json(milestone, { status: 201 });
	} catch (error) {
		console.error("Error creating milestone:", error);
		return Response.json({ error: "Failed to create milestone" }, { status: 500 });
	}
}

export async function handleArchiveMilestone(
	milestoneId: string,
	core: Core,
	broadcast: () => void,
): Promise<Response> {
	try {
		const result = await core.archiveMilestone(milestoneId);
		if (!result.success) {
			return Response.json({ error: "Milestone not found" }, { status: 404 });
		}
		broadcast();
		return Response.json({ success: true, milestone: result.milestone ?? null });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Failed to archive milestone";
		console.error("Error archiving milestone:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}
