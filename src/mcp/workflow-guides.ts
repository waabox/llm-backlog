import { MCP_WORKFLOW_TEMPLATE } from "../guidelines/mcp/index.ts";

export interface WorkflowGuideDefinition {
	key: "overview";
	uri: string;
	name: string;
	description: string;
	mimeType: string;
	toolName: string;
	toolDescription: string;
}

export const WORKFLOW_GUIDES: WorkflowGuideDefinition[] = [
	{
		key: "overview",
		uri: "backlog://workflow/overview",
		name: "Backlog Workflow",
		description: "Complete workflow guide for Backlog.md task management",
		mimeType: "text/markdown",
		toolName: "get_workflow_overview",
		toolDescription: "Retrieve the Backlog.md workflow guide in markdown format",
	},
];

export function renderWorkflowGuide(statuses: readonly string[]): string {
	return MCP_WORKFLOW_TEMPLATE.replace("{{STATUSES}}", statuses.join(", "));
}

export function getWorkflowGuideByUri(uri: string): WorkflowGuideDefinition | undefined {
	return WORKFLOW_GUIDES.find((guide) => guide.uri === uri);
}
