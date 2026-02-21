/**
 * Canonical helpers for status and priority display classes.
 *
 * All components that need status or priority styling should import from here
 * instead of defining their own local copies.
 */

/**
 * Returns true when the given status string represents a completed/done state.
 * Matches any status that contains "done" or "complete" (case-insensitive).
 */
export const isDoneStatus = (status?: string | null): boolean => {
	const normalized = (status ?? "").trim().toLowerCase();
	return normalized.includes("done") || normalized.includes("complete");
};

/**
 * Returns the Tailwind badge class for a task status pill.
 *
 * Covers the following cases:
 *   done / complete  → emerald (green)
 *   progress / doing → yellow
 *   blocked / stuck  → red
 *   everything else  → stone (neutral)
 *
 * Includes transition classes so the badge animates smoothly on theme changes.
 */
export const getStatusBadgeClass = (status?: string | null): string => {
	const normalized = (status ?? "").toLowerCase();
	if (normalized.includes("done") || normalized.includes("complete")) {
		return "bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200 transition-colors duration-200";
	}
	if (normalized.includes("progress") || normalized.includes("doing")) {
		return "bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200 transition-colors duration-200";
	}
	if (normalized.includes("blocked") || normalized.includes("stuck")) {
		return "bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200 transition-colors duration-200";
	}
	return "bg-stone-100 dark:bg-stone-900 text-stone-800 dark:text-stone-200 transition-colors duration-200";
};

/**
 * Returns the Tailwind badge class for a task priority pill.
 *
 * Covers high / medium / low priorities; returns an empty string for anything
 * else so callers can choose to omit the badge entirely.
 */
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

/**
 * Returns the Tailwind background + text class for a status label in list/table views.
 *
 * Uses exact, well-known status names (to do / in progress / done) and falls
 * back to a neutral gray for any custom statuses.
 */
export const getStatusColor = (status: string): string => {
	switch (status.toLowerCase()) {
		case "to do":
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
		case "in progress":
			return "bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-200";
		case "done":
			return "bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-200";
		default:
			return "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200";
	}
};
