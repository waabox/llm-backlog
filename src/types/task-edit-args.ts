export interface TaskEditArgs {
	title?: string;
	description?: string;
	status?: string;
	priority?: "high" | "medium" | "low";
	milestone?: string | null;
	labels?: string[];
	addLabels?: string[];
	removeLabels?: string[];
	assignee?: string[];
	ordinal?: number;
	dependencies?: string[];
	references?: string[];
	addReferences?: string[];
	removeReferences?: string[];
	documentation?: string[];
	addDocumentation?: string[];
	removeDocumentation?: string[];
	implementationPlan?: string;
	planSet?: string;
	planAppend?: string[];
	planClear?: boolean;
	finalSummary?: string;
	finalSummaryAppend?: string[];
	finalSummaryClear?: boolean;
}

export type TaskEditRequest = TaskEditArgs & { id: string };
