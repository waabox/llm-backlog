import React, { useMemo, useState } from "react";
import type { Milestone, Task } from "../../types";
import { useAuth } from "../contexts/AuthContext";
import MilestoneTaskRow from "./MilestoneTaskRow";

interface MyWorkPageProps {
	tasks: Task[];
	milestoneEntities: Milestone[];
	onEditTask: (task: Task) => void;
}

const NO_MILESTONE_KEY = "__none__";

const isDoneStatus = (status?: string | null): boolean => {
	const normalized = (status ?? "").toLowerCase();
	return normalized.includes("done") || normalized.includes("complete");
};

const getStatusBadgeClass = (status?: string | null): string => {
	const normalized = (status ?? "").toLowerCase();
	if (normalized.includes("done") || normalized.includes("complete"))
		return "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-700 dark:text-emerald-300";
	if (normalized.includes("progress"))
		return "bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300";
	return "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300";
};

const getPriorityBadgeClass = (priority?: string): string => {
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

const noop = () => {};

interface TaskGroup {
	key: string;
	label: string;
	tasks: Task[];
}

const MyWorkPage: React.FC<MyWorkPageProps> = ({ tasks, milestoneEntities, onEditTask }) => {
	const { user } = useAuth();
	const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

	const toggleGroup = (key: string): void => {
		setCollapsedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
	};

	const assignedTasks = useMemo((): Task[] => {
		if (!user) return [];

		return tasks.filter((task) => {
			const entries = task.assignee ?? [];
			const matchesEmail = entries.some((entry) => entry.includes(user.email));
			if (matchesEmail) return true;
			return entries.some((entry) => entry.includes(user.name));
		});
	}, [tasks, user]);

	const groups = useMemo((): TaskGroup[] => {
		const milestoneMap = new Map<string, Milestone>(
			milestoneEntities.map((m) => [m.id, m]),
		);

		const byKey = new Map<string, Task[]>();

		for (const task of assignedTasks) {
			const key = task.milestone ?? NO_MILESTONE_KEY;
			const existing = byKey.get(key);
			if (existing) {
				existing.push(task);
			} else {
				byKey.set(key, [task]);
			}
		}

		const result: TaskGroup[] = [];

		// Milestone groups first, preserving insertion order (natural order)
		for (const [key, groupTasks] of byKey.entries()) {
			if (key === NO_MILESTONE_KEY) continue;
			const milestone = milestoneMap.get(key);
			result.push({
				key,
				label: milestone?.title ?? key,
				tasks: groupTasks,
			});
		}

		// "No Milestone" group last
		const noMilestoneTasks = byKey.get(NO_MILESTONE_KEY);
		if (noMilestoneTasks && noMilestoneTasks.length > 0) {
			result.push({
				key: NO_MILESTONE_KEY,
				label: "No Milestone",
				tasks: noMilestoneTasks,
			});
		}

		return result;
	}, [assignedTasks, milestoneEntities]);

	if (!user) {
		return (
			<div className="flex flex-col items-center justify-center py-24 text-center bg-gray-50 dark:bg-gray-900 min-h-full">
				<svg
					className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
					/>
				</svg>
				<p className="text-gray-500 dark:text-gray-400">Sign in to see your assigned tasks.</p>
			</div>
		);
	}

	if (assignedTasks.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-24 text-center bg-gray-50 dark:bg-gray-900 min-h-full">
				<svg
					className="w-12 h-12 text-gray-300 dark:text-gray-600 mb-4"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={1.5}
						d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"
					/>
				</svg>
				<p className="text-gray-500 dark:text-gray-400">No tasks assigned to you.</p>
			</div>
		);
	}

	return (
		<div className="container mx-auto px-4 py-8 bg-gray-50 dark:bg-gray-900 min-h-full transition-colors duration-200">
			{/* Page header */}
			<div className="mb-6">
				<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">My Work</h1>
				<p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
					{assignedTasks.length} task{assignedTasks.length === 1 ? "" : "s"} assigned to you
				</p>
			</div>

			{/* Milestone groups */}
			<div className="space-y-4">
				{groups.map((group) => {
					const isCollapsed = collapsedGroups[group.key] ?? false;

					return (
						<div
							key={group.key}
							className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden"
						>
							{/* Section header */}
							<div
								className="flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
								onClick={() => toggleGroup(group.key)}
							>
								<div className="flex items-center gap-3">
									<svg
										className={`w-4 h-4 text-gray-400 transition-transform ${isCollapsed ? "-rotate-90" : ""}`}
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
									</svg>
									<h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
										{group.label}
									</h2>
									<span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300">
										{group.tasks.length}
									</span>
								</div>
							</div>

							{/* Task rows */}
							{!isCollapsed && (
								<div className="border-t border-gray-200 dark:border-gray-700">
									{/* Column header */}
									<div className="grid grid-cols-[auto_auto_1fr_auto_auto] gap-3 px-3 py-2 bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
										<div className="w-6" />
										<div className="w-24">ID</div>
										<div>Title</div>
										<div className="text-center w-24">Status</div>
										<div className="text-center w-20">Priority</div>
									</div>

									<div className="divide-y divide-gray-200 dark:divide-gray-700">
										{group.tasks.map((task) => (
											<MilestoneTaskRow
												key={task.id}
												task={task}
												isDone={isDoneStatus(task.status)}
												statusBadgeClass={getStatusBadgeClass(task.status)}
												priorityBadgeClass={getPriorityBadgeClass(task.priority)}
												onEditTask={onEditTask}
												onDragStart={noop}
												onDragEnd={noop}
											/>
										))}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
};

export default MyWorkPage;
