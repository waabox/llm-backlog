export const isDoneStatus = (status?: string | null): boolean => {
	const normalized = (status ?? "").toLowerCase();
	return normalized.includes("done") || normalized.includes("complete");
};

export const getStatusBadgeClass = (status?: string | null): string => {
	const normalized = (status ?? "").toLowerCase();
	if (normalized.includes("done") || normalized.includes("complete"))
		return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300";
	if (normalized.includes("progress")) return "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300";
	return "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300";
};

export const getPriorityBadgeClass = (priority?: string): string => {
	switch (priority?.toLowerCase()) {
		case "high":
			return "bg-red-100 dark:bg-red-900/50 text-red-700 dark:text-red-300";
		case "medium":
			return "bg-yellow-100 dark:bg-yellow-900/50 text-yellow-700 dark:text-yellow-300";
		case "low":
			return "bg-green-100 dark:bg-green-900/50 text-green-700 dark:text-green-300";
		default:
			return "";
	}
};

export const noop = (): void => {};
