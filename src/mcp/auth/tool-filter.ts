import type { McpToolHandler } from "../types.ts";

const READ_ONLY_SUFFIXES = ["_list", "_search", "_view"];
const READ_ONLY_PREFIXES = ["get_"];

/**
 * Determines if an MCP tool is read-only based on its name.
 * Read-only tools: list, search, view operations and workflow guides.
 * Write tools: create, edit, archive, complete, update, add, rename, remove.
 */
export function isReadOnlyTool(toolName: string): boolean {
	for (const suffix of READ_ONLY_SUFFIXES) {
		if (toolName.endsWith(suffix)) return true;
	}
	for (const prefix of READ_ONLY_PREFIXES) {
		if (toolName.startsWith(prefix)) return true;
	}
	return false;
}

/**
 * Filters a list of tools based on the user's role.
 * Admin gets all tools. Viewer gets only read-only tools.
 * If role is undefined (no auth), all tools are returned.
 */
export function filterToolsByRole(tools: McpToolHandler[], role: "admin" | "viewer" | undefined): McpToolHandler[] {
	if (role === undefined || role === "admin") {
		return tools;
	}
	return tools.filter((tool) => isReadOnlyTool(tool.name));
}
