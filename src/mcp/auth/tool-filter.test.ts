import { describe, expect, it } from "bun:test";
import type { McpToolHandler } from "../types.ts";
import { filterToolsByRole, isReadOnlyTool } from "./tool-filter.ts";

function makeTool(name: string): McpToolHandler {
	return {
		name,
		description: `Test tool: ${name}`,
		inputSchema: {},
		handler: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

describe("isReadOnlyTool", () => {
	it("classifies list/search/view tools as read-only", () => {
		expect(isReadOnlyTool("task_list")).toBe(true);
		expect(isReadOnlyTool("task_search")).toBe(true);
		expect(isReadOnlyTool("task_view")).toBe(true);
		expect(isReadOnlyTool("document_list")).toBe(true);
		expect(isReadOnlyTool("document_view")).toBe(true);
		expect(isReadOnlyTool("document_search")).toBe(true);
		expect(isReadOnlyTool("milestone_list")).toBe(true);
	});

	it("classifies workflow tools as read-only", () => {
		expect(isReadOnlyTool("get_workflow_overview")).toBe(true);
		expect(isReadOnlyTool("get_task_creation_guide")).toBe(true);
		expect(isReadOnlyTool("get_task_execution_guide")).toBe(true);
		expect(isReadOnlyTool("get_task_finalization_guide")).toBe(true);
	});

	it("classifies create/edit/archive/complete/update/add/rename/remove tools as write", () => {
		expect(isReadOnlyTool("task_create")).toBe(false);
		expect(isReadOnlyTool("task_edit")).toBe(false);
		expect(isReadOnlyTool("task_archive")).toBe(false);
		expect(isReadOnlyTool("task_complete")).toBe(false);
		expect(isReadOnlyTool("document_create")).toBe(false);
		expect(isReadOnlyTool("document_update")).toBe(false);
		expect(isReadOnlyTool("milestone_add")).toBe(false);
		expect(isReadOnlyTool("milestone_rename")).toBe(false);
		expect(isReadOnlyTool("milestone_remove")).toBe(false);
		expect(isReadOnlyTool("milestone_archive")).toBe(false);
	});
});

describe("filterToolsByRole", () => {
	const allTools = [
		makeTool("task_list"),
		makeTool("task_create"),
		makeTool("task_view"),
		makeTool("task_edit"),
		makeTool("document_list"),
		makeTool("document_create"),
		makeTool("get_workflow_overview"),
	];

	it("returns all tools for admin", () => {
		const filtered = filterToolsByRole(allTools, "admin");
		expect(filtered.length).toBe(allTools.length);
	});

	it("returns only read-only tools for viewer", () => {
		const filtered = filterToolsByRole(allTools, "viewer");
		const names = filtered.map((t) => t.name);
		expect(names).toContain("task_list");
		expect(names).toContain("task_view");
		expect(names).toContain("document_list");
		expect(names).toContain("get_workflow_overview");
		expect(names).not.toContain("task_create");
		expect(names).not.toContain("task_edit");
		expect(names).not.toContain("document_create");
	});

	it("returns all tools when role is undefined (no auth)", () => {
		const filtered = filterToolsByRole(allTools, undefined);
		expect(filtered.length).toBe(allTools.length);
	});
});
