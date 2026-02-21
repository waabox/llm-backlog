import type { BacklogConfig } from "../../../types/index.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { generateTaskCreateSchema, generateTaskEditSchema } from "../../utils/schema-generators.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { TaskCreateArgs, TaskEditRequest, TaskListArgs, TaskSearchArgs } from "./handlers.ts";
import { TaskHandlers } from "./handlers.ts";
import { taskArchiveSchema, taskCompleteSchema, taskListSchema, taskSearchSchema, taskViewSchema } from "./schemas.ts";

export function registerTaskTools(server: McpServer, config: BacklogConfig): void {
	const handlers = new TaskHandlers(server);

	const taskCreateSchema = generateTaskCreateSchema(config);
	const taskEditSchema = generateTaskEditSchema(config);

	const createTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_create",
			description: "Create a new task using Backlog.md",
			inputSchema: taskCreateSchema,
		},
		taskCreateSchema,
		async (input) => handlers.createTask(input as TaskCreateArgs),
	);

	const listTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_list",
			description: "List Backlog.md tasks from with optional filtering",
			inputSchema: taskListSchema,
		},
		taskListSchema,
		async (input) => handlers.listTasks(input as TaskListArgs),
	);

	const searchTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_search",
			description: "Search Backlog.md tasks by title and description",
			inputSchema: taskSearchSchema,
		},
		taskSearchSchema,
		async (input) => handlers.searchTasks(input as TaskSearchArgs),
	);

	const editTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_edit",
			description: "Edit a Backlog.md task, including metadata, implementation plan, final summary, and dependencies",
			inputSchema: taskEditSchema,
		},
		taskEditSchema,
		async (input) => handlers.editTask(input as unknown as TaskEditRequest),
	);

	const viewTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_view",
			description: "View a Backlog.md task details",
			inputSchema: taskViewSchema,
		},
		taskViewSchema,
		async (input) => handlers.viewTask(input as { id: string }),
	);

	const archiveTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_archive",
			description: "Archive a Backlog.md task",
			inputSchema: taskArchiveSchema,
		},
		taskArchiveSchema,
		async (input) => handlers.archiveTask(input as { id: string }),
	);

	const completeTaskTool: McpToolHandler = createSimpleValidatedTool(
		{
			name: "task_complete",
			description: "Complete a Backlog.md task (move it to the completed folder)",
			inputSchema: taskCompleteSchema,
		},
		taskCompleteSchema,
		async (input) => handlers.completeTask(input as { id: string }),
	);

	server.addTool(createTaskTool);
	server.addTool(listTaskTool);
	server.addTool(searchTaskTool);
	server.addTool(editTaskTool);
	server.addTool(viewTaskTool);
	server.addTool(archiveTaskTool);
	server.addTool(completeTaskTool);
}

/**
 * Creates a per-request task_move tool with the current user's name baked in.
 * Automatically assigns the task to the caller when they are not already an
 * assignee, then moves the task to "In Progress". If the caller is already an
 * assignee, moves the task to the requested status.
 *
 * Used by the HTTP transport to inject authenticated user context into the tool.
 */
export function createMoveTaskTool(server: McpServer, currentUser: string): McpToolHandler {
	const handlers = new TaskHandlers(server);
	return createSimpleValidatedTool(
		{
			name: "task_move",
			description: `Move a task to a specified status. If you (${currentUser}) are not the current assignee, the task will first be assigned to you and moved to "In Progress".`,
			inputSchema: {
				properties: {
					id: { type: "string", description: "Task ID to move" },
					status: { type: "string", description: "Target status" },
				},
				required: ["id", "status"],
			},
		},
		{ properties: { id: { type: "string" }, status: { type: "string" } }, required: ["id", "status"] },
		async (input) =>
			handlers.moveTask({ id: input.id as string, status: input.status as string, assignee: currentUser }),
	);
}

/**
 * Creates a per-request task_take tool with the current user's name baked in.
 * Used by the HTTP transport to inject authenticated user context into the tool.
 */
export function createTakeTaskTool(server: McpServer, currentUser: string): McpToolHandler {
	const handlers = new TaskHandlers(server);
	return createSimpleValidatedTool(
		{
			name: "task_take",
			description: `Assign a task to yourself (${currentUser})`,
			inputSchema: {
				properties: { id: { type: "string", description: "Task ID to take" } },
				required: ["id"],
			},
		},
		{ properties: { id: { type: "string" } }, required: ["id"] },
		async (input) => handlers.takeTask({ id: input.id as string, assignee: currentUser }),
	);
}

export type { TaskCreateArgs, TaskEditArgs, TaskListArgs, TaskSearchArgs } from "./handlers.ts";
export { taskArchiveSchema, taskCompleteSchema, taskListSchema, taskSearchSchema, taskViewSchema } from "./schemas.ts";
