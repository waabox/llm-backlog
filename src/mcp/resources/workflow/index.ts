import { DEFAULT_STATUSES } from "../../../constants/index.ts";
import type { McpServer } from "../../server.ts";
import { renderWorkflowGuide, WORKFLOW_GUIDES } from "../../workflow-guides.ts";

export function registerWorkflowResources(server: McpServer): void {
	for (const guide of WORKFLOW_GUIDES) {
		server.addResource({
			uri: guide.uri,
			name: guide.name,
			description: guide.description,
			mimeType: guide.mimeType,
			handler: async () => {
				const config = await server.fs.loadConfig();
				const statuses = config?.statuses ?? [...DEFAULT_STATUSES];
				const text = renderWorkflowGuide(statuses);
				return {
					contents: [{ uri: guide.uri, mimeType: guide.mimeType, text }],
				};
			},
		});
	}
}
