import { useState, useEffect } from "react";
import { apiClient } from "../lib/api.ts";
import type { BacklogConfig } from "../../types/index.ts";

type Tab = "general" | "labels" | "statuses" | "advanced";

function ChipInput({
	items,
	onAdd,
	onRemove,
	placeholder,
}: {
	items: string[];
	onAdd: (item: string) => void;
	onRemove: (item: string) => void;
	placeholder: string;
}) {
	const [input, setInput] = useState("");

	const add = () => {
		const trimmed = input.trim();
		if (trimmed && !items.includes(trimmed)) {
			onAdd(trimmed);
			setInput("");
		}
	};

	return (
		<div className="space-y-3">
			<div className="flex gap-2">
				<input
					type="text"
					value={input}
					onChange={(e) => setInput(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && add()}
					placeholder={placeholder}
					className="border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 min-w-[200px]"
				/>
				<button
					type="button"
					onClick={add}
					className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700 transition-colors"
				>
					+ Add
				</button>
			</div>
			<div className="flex flex-wrap gap-2">
				{items.map((item) => (
					<span
						key={item}
						className="inline-flex items-center gap-1 px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-full text-sm"
					>
						{item}
						<button
							type="button"
							onClick={() => onRemove(item)}
							className="ml-1 text-gray-400 hover:text-red-500 transition-colors leading-none"
							aria-label={`Remove ${item}`}
						>
							×
						</button>
					</span>
				))}
				{items.length === 0 && <span className="text-sm text-gray-400 dark:text-gray-500 italic">None defined</span>}
			</div>
		</div>
	);
}

export function SettingsPage() {
	const [config, setConfig] = useState<BacklogConfig | null>(null);
	const [activeTab, setActiveTab] = useState<Tab>("labels");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [success, setSuccess] = useState(false);

	const [labels, setLabels] = useState<string[]>([]);
	const [statuses, setStatuses] = useState<string[]>([]);
	const [projectName, setProjectName] = useState("");
	const [defaultStatus, setDefaultStatus] = useState("");
	const [defaultAssignee, setDefaultAssignee] = useState("");
	const [autoCommit, setAutoCommit] = useState(false);
	const [autoOpenBrowser, setAutoOpenBrowser] = useState(false);
	const [maxColumnWidth, setMaxColumnWidth] = useState(20);
	const [activeBranchDays, setActiveBranchDays] = useState(10);

	useEffect(() => {
		apiClient.fetchConfig().then((cfg) => {
			setConfig(cfg);
			setLabels(cfg.labels ?? []);
			setStatuses(cfg.statuses ?? []);
			setProjectName(cfg.projectName ?? "");
			setDefaultStatus(cfg.defaultStatus ?? "");
			setDefaultAssignee(cfg.defaultAssignee ?? "");
			setAutoCommit(cfg.autoCommit ?? false);
			setAutoOpenBrowser(cfg.autoOpenBrowser ?? false);
			setMaxColumnWidth(cfg.maxColumnWidth ?? 20);
			setActiveBranchDays(cfg.activeBranchDays ?? 10);
		});
	}, []);

	const handleSave = async () => {
		if (!config) return;
		setSaving(true);
		setError(null);
		setSuccess(false);
		try {
			const updated = await apiClient.updateConfig({
				...config,
				labels,
				statuses,
				projectName,
				defaultStatus: defaultStatus || undefined,
				defaultAssignee: defaultAssignee || undefined,
				autoCommit,
				autoOpenBrowser,
				maxColumnWidth,
				activeBranchDays,
			});
			setConfig(updated);
			setSuccess(true);
			setTimeout(() => setSuccess(false), 3000);
		} catch {
			setError("Failed to save settings. Please try again.");
		} finally {
			setSaving(false);
		}
	};

	const tabs: { id: Tab; label: string }[] = [
		{ id: "general", label: "General" },
		{ id: "labels", label: "Labels" },
		{ id: "statuses", label: "Statuses" },
		{ id: "advanced", label: "Advanced" },
	];

	const tabClass = (id: Tab) =>
		`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
			activeTab === id
				? "border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400"
				: "border-transparent text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:border-gray-300"
		}`;

	const inputClass =
		"border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 w-full max-w-sm";

	const labelClass = "block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1";

	if (!config) {
		return (
			<div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
				Loading settings…
			</div>
		);
	}

	return (
		<div className="p-6 max-w-3xl mx-auto">
			<h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-6">Settings</h1>

			{/* Tabs */}
			<div className="border-b border-gray-200 dark:border-gray-700 mb-6 flex gap-1">
				{tabs.map((t) => (
					<button key={t.id} type="button" onClick={() => setActiveTab(t.id)} className={tabClass(t.id)}>
						{t.label}
					</button>
				))}
			</div>

			{/* Tab content */}
			<div className="space-y-6">
				{activeTab === "general" && (
					<>
						<div>
							<label className={labelClass}>Project Name</label>
							<input
								type="text"
								value={projectName}
								onChange={(e) => setProjectName(e.target.value)}
								className={inputClass}
							/>
						</div>
						<div>
							<label className={labelClass}>Default Status</label>
							<select
								value={defaultStatus}
								onChange={(e) => setDefaultStatus(e.target.value)}
								className={inputClass}
							>
								<option value="">— none —</option>
								{statuses.map((s) => (
									<option key={s} value={s}>
										{s}
									</option>
								))}
							</select>
						</div>
						<div>
							<label className={labelClass}>Default Assignee</label>
							<input
								type="text"
								value={defaultAssignee}
								onChange={(e) => setDefaultAssignee(e.target.value)}
								placeholder="@username"
								className={inputClass}
							/>
						</div>
					</>
				)}

				{activeTab === "labels" && (
					<div>
						<h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3">Labels</h2>
						<p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
							Labels are used to categorize tasks. Add or remove labels here.
						</p>
						<ChipInput
							items={labels}
							onAdd={(item) => setLabels([...labels, item])}
							onRemove={(item) => setLabels(labels.filter((l) => l !== item))}
							placeholder="New label…"
						/>
					</div>
				)}

				{activeTab === "statuses" && (
					<div>
						<h2 className="text-base font-semibold text-gray-800 dark:text-gray-200 mb-3">Statuses</h2>
						<p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
							Statuses define the workflow stages for your tasks.
						</p>
						<ChipInput
							items={statuses}
							onAdd={(item) => setStatuses([...statuses, item])}
							onRemove={(item) => setStatuses(statuses.filter((s) => s !== item))}
							placeholder="New status…"
						/>
					</div>
				)}

				{activeTab === "advanced" && (
					<>
						<div className="flex items-center justify-between">
							<div>
								<div className={labelClass}>Auto Commit</div>
								<p className="text-xs text-gray-500 dark:text-gray-400">Automatically commit changes to git</p>
							</div>
							<button
								type="button"
								onClick={() => setAutoCommit(!autoCommit)}
								className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
									autoCommit ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
								}`}
							>
								<span
									className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
										autoCommit ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</button>
						</div>
						<div className="flex items-center justify-between">
							<div>
								<div className={labelClass}>Auto Open Browser</div>
								<p className="text-xs text-gray-500 dark:text-gray-400">Open browser automatically on server start</p>
							</div>
							<button
								type="button"
								onClick={() => setAutoOpenBrowser(!autoOpenBrowser)}
								className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
									autoOpenBrowser ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600"
								}`}
							>
								<span
									className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
										autoOpenBrowser ? "translate-x-6" : "translate-x-1"
									}`}
								/>
							</button>
						</div>
						<div>
							<label className={labelClass}>Max Column Width</label>
							<input
								type="number"
								value={maxColumnWidth}
								onChange={(e) => setMaxColumnWidth(Number(e.target.value))}
								min={10}
								max={100}
								className={inputClass}
							/>
						</div>
						<div>
							<label className={labelClass}>Active Branch Days</label>
							<input
								type="number"
								value={activeBranchDays}
								onChange={(e) => setActiveBranchDays(Number(e.target.value))}
								min={1}
								max={365}
								className={inputClass}
							/>
						</div>
					</>
				)}
			</div>

			{/* Save & Push button */}
			<div className="mt-8 flex items-center gap-4">
				<button
					type="button"
					onClick={handleSave}
					disabled={saving}
					className="px-6 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					{saving ? "Saving…" : "Save & Push"}
				</button>
				{success && <span className="text-sm text-green-600 dark:text-green-400">Saved and pushed ✓</span>}
				{error && <span className="text-sm text-red-600 dark:text-red-400">{error}</span>}
			</div>
		</div>
	);
}
