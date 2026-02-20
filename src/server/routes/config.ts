import type { Core } from "../../core/backlog.ts";
import { getTaskStatistics } from "../../core/statistics.ts";
import { getVersion } from "../../utils/version.ts";

export async function handleGetStatuses(core: Core): Promise<Response> {
	const config = await core.filesystem.loadConfig();
	const statuses = config?.statuses || ["To Do", "In Progress", "Done"];
	return Response.json(statuses);
}

export async function handleGetConfig(core: Core): Promise<Response> {
	try {
		const config = await core.filesystem.loadConfig();
		if (!config) {
			return Response.json({ error: "Configuration not found" }, { status: 404 });
		}
		return Response.json(config);
	} catch (error) {
		console.error("Error loading config:", error);
		return Response.json({ error: "Failed to load configuration" }, { status: 500 });
	}
}


export async function handleGetVersion(): Promise<Response> {
	try {
		const version = await getVersion();
		return Response.json({ version });
	} catch (error) {
		console.error("Error getting version:", error);
		return Response.json({ error: "Failed to get version" }, { status: 500 });
	}
}

export async function handleGetStatus(core: Core): Promise<Response> {
	try {
		const config = await core.filesystem.loadConfig();
		return Response.json({
			initialized: !!config,
			projectPath: core.filesystem.rootDir,
		});
	} catch (error) {
		console.error("Error getting status:", error);
		return Response.json({
			initialized: false,
			projectPath: core.filesystem.rootDir,
		});
	}
}

export async function handleGetStatistics(core: Core): Promise<Response> {
	try {
		// Load tasks using the same logic as CLI overview
		const { tasks, drafts, statuses } = await core.loadAllTasksForStatistics();

		// Calculate statistics using the exact same function as CLI
		const statistics = getTaskStatistics(tasks, drafts, statuses);

		// Convert Maps to objects for JSON serialization
		const response = {
			...statistics,
			statusCounts: Object.fromEntries(statistics.statusCounts),
			priorityCounts: Object.fromEntries(statistics.priorityCounts),
		};

		return Response.json(response);
	} catch (error) {
		console.error("Error getting statistics:", error);
		return Response.json({ error: "Failed to get statistics" }, { status: 500 });
	}
}
