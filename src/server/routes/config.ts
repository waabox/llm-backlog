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

export async function handleUpdateConfig(
	req: Request,
	core: Core,
	broadcast: () => void,
	onProjectNameChanged: (name: string) => void,
): Promise<Response> {
	try {
		const updatedConfig = await req.json();

		// Validate configuration
		if (!updatedConfig.projectName?.trim()) {
			return Response.json({ error: "Project name is required" }, { status: 400 });
		}

		if (updatedConfig.defaultPort && (updatedConfig.defaultPort < 1 || updatedConfig.defaultPort > 65535)) {
			return Response.json({ error: "Port must be between 1 and 65535" }, { status: 400 });
		}

		// Save configuration
		await core.filesystem.saveConfig(updatedConfig);

		// Notify caller if project name changed
		onProjectNameChanged(updatedConfig.projectName);

		// Notify connected clients so that they refresh configuration-dependent data (e.g., statuses)
		broadcast();

		return Response.json(updatedConfig);
	} catch (error) {
		console.error("Error updating config:", error);
		return Response.json({ error: "Failed to update configuration" }, { status: 500 });
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
