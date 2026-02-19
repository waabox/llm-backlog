import type { Core } from "../../core/backlog.ts";
import type { ContentStore } from "../../core/content-store.ts";
import { initializeProject } from "../../core/init.ts";

export async function handleInit(
	req: Request,
	core: Core,
	contentStore: ContentStore | null,
	onProjectNameChanged: (name: string) => void,
): Promise<Response> {
	try {
		const body = await req.json();
		const projectName = typeof body.projectName === "string" ? body.projectName.trim() : "";
		const integrationMode = body.integrationMode as "mcp" | "cli" | "none" | undefined;
		const mcpClients = Array.isArray(body.mcpClients) ? body.mcpClients : [];
		const agentInstructions = Array.isArray(body.agentInstructions) ? body.agentInstructions : [];
		const installClaudeAgentFlag = Boolean(body.installClaudeAgent);
		const advancedConfig = body.advancedConfig || {};

		// Input validation (browser layer responsibility)
		if (!projectName) {
			return Response.json({ error: "Project name is required" }, { status: 400 });
		}

		// Check if already initialized (for browser, we don't allow re-init)
		const existingConfig = await core.filesystem.loadConfig();
		if (existingConfig) {
			return Response.json({ error: "Project is already initialized" }, { status: 400 });
		}

		// Call shared core init function
		const result = await initializeProject(core, {
			projectName,
			integrationMode: integrationMode || "none",
			mcpClients,
			agentInstructions,
			installClaudeAgent: installClaudeAgentFlag,
			advancedConfig,
			existingConfig: null,
		});

		// Update server's project name
		onProjectNameChanged(result.projectName);

		// Ensure config watcher is set up now that config file exists
		if (contentStore) {
			contentStore.ensureConfigWatcher();
		}

		return Response.json({
			success: result.success,
			projectName: result.projectName,
			mcpResults: result.mcpResults,
		});
	} catch (error) {
		console.error("Error initializing project:", error);
		const message = error instanceof Error ? error.message : "Failed to initialize project";
		return Response.json({ error: message }, { status: 500 });
	}
}
