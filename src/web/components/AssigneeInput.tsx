import React, { useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api";

interface User {
	email: string;
	name: string;
}

interface AssigneeInputProps {
	value: string[];
	onChange: (values: string[]) => void;
	disabled?: boolean;
}

/**
 * Extracts the display label from an assignee chip value.
 * Supports "Name <email>" git author format — shows only the email.
 * Falls back to the raw string for backwards compatibility.
 */
function displayLabel(chip: string): string {
	const match = chip.match(/<(.+)>/);
	return match?.[1] ?? chip;
}

const AssigneeInput: React.FC<AssigneeInputProps> = ({ value, onChange, disabled }) => {
	const [users, setUsers] = useState<User[]>([]);
	const [inputValue, setInputValue] = useState("");
	const [open, setOpen] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		apiClient
			.fetchUsers()
			.then(setUsers)
			.catch(() => setUsers([]));
	}, []);

	const filtered =
		inputValue.trim().length > 0
			? users.filter(
					(u) =>
						u.name.toLowerCase().includes(inputValue.toLowerCase()) ||
						u.email.toLowerCase().includes(inputValue.toLowerCase()),
				)
			: users;

	const addChip = (chip: string) => {
		const trimmed = chip.trim();
		if (!trimmed || value.includes(trimmed)) return;
		onChange([...value, trimmed]);
	};

	const removeChip = (index: number) => {
		if (disabled) return;
		onChange(value.filter((_, i) => i !== index));
	};

	const selectUser = (user: User) => {
		addChip(`${user.name} <${user.email}>`);
		setInputValue("");
		setOpen(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (disabled) return;
		if ((e.key === "Enter" || e.key === ",") && inputValue.trim()) {
			e.preventDefault();
			addChip(inputValue);
			setInputValue("");
			setOpen(false);
		} else if (e.key === "Backspace" && !inputValue && value.length > 0) {
			onChange(value.slice(0, -1));
		} else if (e.key === "Escape") {
			setOpen(false);
		}
	};

	const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
		if (disabled) return;
		const v = e.target.value;
		if (v.endsWith(",")) {
			const chip = v.slice(0, -1).trim();
			if (chip) addChip(chip);
			setInputValue("");
			setOpen(false);
		} else {
			setInputValue(v);
			setOpen(v.trim().length > 0 || users.length > 0);
		}
	};

	const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
		// Delay so click on dropdown item registers first
		setTimeout(() => {
			if (containerRef.current && !containerRef.current.contains(document.activeElement)) {
				if (inputValue.trim()) addChip(inputValue);
				setInputValue("");
				setOpen(false);
			}
		}, 150);
	};

	const handleFocus = () => {
		if (!disabled) setOpen(true);
	};

	return (
		<div className="relative w-full" ref={containerRef}>
			<div
				className={`relative w-full min-h-10 px-3 py-2 border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 rounded-md focus-within:ring-2 focus-within:ring-blue-500 dark:focus-within:ring-blue-400 focus-within:border-transparent transition-colors duration-200 ${disabled ? "opacity-60 cursor-not-allowed" : ""}`}
			>
				<div className="flex flex-wrap gap-2 items-center w-full">
					{value.map((item, index) => (
						<span
							key={index}
							className="inline-flex items-center gap-1 px-2 py-0.5 text-sm bg-blue-100 dark:bg-blue-900/50 text-blue-800 dark:text-blue-200 rounded-md flex-shrink-0 min-w-0 max-w-full transition-colors duration-200"
						>
							<span className="truncate max-w-[16rem] sm:max-w-[20rem] md:max-w-[24rem]">{displayLabel(item)}</span>
							{!disabled && (
								<button
									type="button"
									onClick={() => removeChip(index)}
									className="hover:bg-blue-200 dark:hover:bg-blue-800 rounded-sm p-0.5 transition-colors duration-200"
									aria-label={`Remove ${displayLabel(item)}`}
								>
									<svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
										<path
											fillRule="evenodd"
											d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
											clipRule="evenodd"
										/>
									</svg>
								</button>
							)}
						</span>
					))}
					<input
						type="text"
						value={inputValue}
						onChange={handleInputChange}
						onKeyDown={handleKeyDown}
						onBlur={handleBlur}
						onFocus={handleFocus}
						placeholder={value.length === 0 ? "Type name or email…" : ""}
						className="flex-1 min-w-[2ch] outline-none text-sm bg-transparent text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400"
						disabled={disabled}
					/>
				</div>
			</div>

			{open && !disabled && filtered.length > 0 && (
				<ul className="absolute z-50 mt-1 w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-lg max-h-48 overflow-y-auto text-sm">
					{filtered.map((user) => (
						<li key={user.email}>
							<button
								type="button"
								onMouseDown={(e) => {
									e.preventDefault();
									selectUser(user);
								}}
								className="w-full text-left px-3 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-900 dark:text-gray-100 transition-colors duration-150"
							>
								{user.name}{" "}
								<span className="text-gray-500 dark:text-gray-400">({user.email})</span>
							</button>
						</li>
					))}
				</ul>
			)}
		</div>
	);
};

export default AssigneeInput;
