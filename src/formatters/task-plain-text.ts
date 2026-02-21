import type { Task } from "../types/index.ts";
import { sortByTaskId } from "../utils/task-sorting.ts";
import { transformCodePathsPlain } from "./code-path.ts";


const STATUS_ICONS: Record<string, string> = {
	"Done": "✔",
	"In Progress": "◒",
	"Blocked": "●",
	"To Do": "○",
	"Review": "◆",
	"Testing": "▣",
};

function formatStatusWithIcon(status: string): string {
	const icon = STATUS_ICONS[status] ?? "○";
	return `${icon} ${status}`;
}

export type TaskPlainTextOptions = {
	filePathOverride?: string;
	compact?: boolean;
};

export function formatDateForDisplay(dateStr: string): string {
	if (!dateStr) return "";
	const hasTime = dateStr.includes(" ") || dateStr.includes("T");
	return hasTime ? dateStr : dateStr;
}

function formatPriority(priority?: "high" | "medium" | "low"): string | null {
	if (!priority) return null;
	const label = priority.charAt(0).toUpperCase() + priority.slice(1);
	return label;
}

function formatAssignees(assignee?: string[]): string | null {
	if (!assignee || assignee.length === 0) return null;
	return assignee.map((a) => (a.startsWith("@") ? a : `@${a}`)).join(", ");
}

function formatSubtaskLines(subtasks: Array<{ id: string; title: string }>): string[] {
	if (subtasks.length === 0) return [];
	const sorted = sortByTaskId(subtasks);
	return sorted.map((subtask) => `- ${subtask.id} - ${subtask.title}`);
}

export function formatTaskPlainText(task: Task, options: TaskPlainTextOptions = {}): string {
	const lines: string[] = [];

	lines.push(`Task ${task.id} - ${task.title}`);

	if (options.compact) {
		return lines.join("\n");
	}

	lines.push("=".repeat(50));
	lines.push("");
	lines.push(`Status: ${formatStatusWithIcon(task.status)}`);

	const priorityLabel = formatPriority(task.priority);
	if (priorityLabel) {
		lines.push(`Priority: ${priorityLabel}`);
	}

	const assigneeText = formatAssignees(task.assignee);
	if (assigneeText) {
		lines.push(`Assignee: ${assigneeText}`);
	}

	if (task.reporter) {
		const reporter = task.reporter.startsWith("@") ? task.reporter : `@${task.reporter}`;
		lines.push(`Reporter: ${reporter}`);
	}

	lines.push(`Created: ${formatDateForDisplay(task.createdDate)}`);
	if (task.updatedDate) {
		lines.push(`Updated: ${formatDateForDisplay(task.updatedDate)}`);
	}

	if (task.labels?.length) {
		lines.push(`Labels: ${task.labels.join(", ")}`);
	}

	if (task.milestone) {
		lines.push(`Milestone: ${task.milestone}`);
	}

	if (task.parentTaskId) {
		const parentLabel = task.parentTaskTitle ? `${task.parentTaskId} - ${task.parentTaskTitle}` : task.parentTaskId;
		lines.push(`Parent: ${parentLabel}`);
	}

	const subtaskSummaries = task.subtaskSummaries ?? [];
	const subtaskCount = subtaskSummaries.length > 0 ? subtaskSummaries.length : (task.subtasks?.length ?? 0);
	if (subtaskCount > 0) {
		const subtaskLines = formatSubtaskLines(subtaskSummaries);
		if (subtaskLines.length > 0) {
			lines.push(`Subtasks (${subtaskCount}):`);
			lines.push(...subtaskLines);
		} else {
			lines.push(`Subtasks: ${subtaskCount}`);
		}
	}

	if (task.dependencies?.length) {
		lines.push(`Dependencies: ${task.dependencies.join(", ")}`);
	}

	if (task.references?.length) {
		lines.push(`References: ${task.references.join(", ")}`);
	}

	if (task.documentation?.length) {
		lines.push(`Documentation: ${task.documentation.join(", ")}`);
	}

	lines.push("");
	lines.push("Description:");
	lines.push("-".repeat(50));
	const description = task.description?.trim();
	lines.push(transformCodePathsPlain(description && description.length > 0 ? description : "No description provided"));
	lines.push("");

	const implementationPlan = task.implementationPlan?.trim();
	if (implementationPlan) {
		lines.push("Implementation Plan:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(implementationPlan));
		lines.push("");
	}

	const finalSummary = task.finalSummary?.trim();
	if (finalSummary) {
		lines.push("Final Summary:");
		lines.push("-".repeat(50));
		lines.push(transformCodePathsPlain(finalSummary));
		lines.push("");
	}

	return lines.join("\n");
}
