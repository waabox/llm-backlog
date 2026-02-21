import { StorageCoordinator } from "../../../file-system/storage-coordinator.ts";
import type { McpServer } from "../../server.ts";
import type { McpToolHandler } from "../../types.ts";
import { createSimpleValidatedTool } from "../../validation/tool-wrapper.ts";
import type { JsonSchema } from "../../validation/validators.ts";

const emptyInputSchema: JsonSchema = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
};

export function createSyncTool(server: McpServer): McpToolHandler {
	return createSimpleValidatedTool(
		{
			name: "backlog_sync",
			description:
				"Rebuild the SQLite index from all markdown files in the backlog directory. " +
				"Run this after manually editing markdown files outside the tool, or after a git pull.",
			inputSchema: emptyInputSchema,
		},
		emptyInputSchema,
		async () => {
			if (!(server.filesystem instanceof StorageCoordinator)) {
				return {
					content: [
						{
							type: "text",
							text: "SQLite coordination layer is not active. No sync needed.",
						},
					],
				};
			}

			const result = await server.filesystem.sync();
			const text =
				"Sync complete.\n" +
				`  Tasks:     ${result.tasks}\n` +
				`  Drafts:    ${result.drafts}\n` +
				`  Completed: ${result.completed}`;

			return {
				content: [{ type: "text", text }],
			};
		},
	);
}
