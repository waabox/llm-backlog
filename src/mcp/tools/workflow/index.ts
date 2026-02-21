import { DEFAULT_STATUSES } from "../../../constants/index.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";
import { renderWorkflowGuide, WORKFLOW_GUIDES } from "../../workflow-guides.ts";

const emptyInputSchema: JsonSchema = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
};

function createWorkflowTool(server: McpServer, guide: (typeof WORKFLOW_GUIDES)[number]): McpToolHandler {
	return createSimpleValidatedTool(
		{
			name: guide.toolName,
			description: guide.toolDescription,
			inputSchema: emptyInputSchema,
		},
		emptyInputSchema,
		async () => {
			const config = await server.fs.loadConfig();
			const statuses = config?.statuses ?? [...DEFAULT_STATUSES];
			const text = renderWorkflowGuide(statuses);
			return {
				content: [{ type: "text", text }],
				structuredContent: {
					type: "resource",
					uri: guide.uri,
					title: guide.name,
					description: guide.description,
					mimeType: guide.mimeType,
					text,
				},
			};
		},
	);
}

export function registerWorkflowTools(server: McpServer): void {
	for (const guide of WORKFLOW_GUIDES) {
		server.addTool(createWorkflowTool(server, guide));
	}
}
