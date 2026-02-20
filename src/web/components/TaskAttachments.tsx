import React, { useCallback, useRef, useState } from "react";
import type { AssetMetadata } from "../hooks/useTaskAssets";
import { useTaskAssets } from "../hooks/useTaskAssets";
import { AssetLightbox } from "./AssetLightbox";

const FILE_ICONS: Record<string, string> = {
	pdf: "📄",
	zip: "🗜️",
	tar: "🗜️",
	gz: "🗜️",
	doc: "📝",
	docx: "📝",
	xls: "📊",
	xlsx: "📊",
	mp4: "🎬",
	mov: "🎬",
	mp3: "🎵",
};

function fileIcon(ext: string): string {
	return FILE_ICONS[ext.toLowerCase()] ?? "📎";
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface Props {
	taskId: string;
}

export const TaskAttachments: React.FC<Props> = ({ taskId }) => {
	const { assets, loading, uploading, error, uploadAsset, deleteAsset } = useTaskAssets(taskId);
	const [lightboxAsset, setLightboxAsset] = useState<AssetMetadata | null>(null);
	const [dragOver, setDragOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);

	const handleFiles = useCallback(
		async (files: FileList | null) => {
			if (!files) return;
			for (const file of Array.from(files)) {
				await uploadAsset(file);
			}
		},
		[uploadAsset],
	);

	const onDrop = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault();
			setDragOver(false);
			handleFiles(e.dataTransfer.files);
		},
		[handleFiles],
	);

	const onDragOver = (e: React.DragEvent) => {
		e.preventDefault();
		setDragOver(true);
	};

	const onDragLeave = () => setDragOver(false);

	return (
		<div>
			{/* Upload zone */}
			<div
				onDrop={onDrop}
				onDragOver={onDragOver}
				onDragLeave={onDragLeave}
				className={`border-2 border-dashed rounded-md p-4 text-center cursor-pointer transition-colors ${
					dragOver
						? "border-blue-400 bg-blue-50 dark:bg-blue-900/20"
						: "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
				}`}
				onClick={() => inputRef.current?.click()}
			>
				<input
					ref={inputRef}
					type="file"
					multiple
					className="hidden"
					onChange={(e) => handleFiles(e.target.files)}
				/>
				{uploading ? (
					<span className="text-sm text-gray-500 dark:text-gray-400">Uploading...</span>
				) : (
					<span className="text-sm text-gray-500 dark:text-gray-400">
						Drop files here or <span className="text-blue-500">click to upload</span>
					</span>
				)}
			</div>

			{error && (
				<p className="mt-2 text-sm text-red-600 dark:text-red-400">{error}</p>
			)}

			{/* Asset grid */}
			{loading ? (
				<p className="mt-3 text-sm text-gray-400">Loading attachments...</p>
			) : assets.length > 0 ? (
				<div className="mt-3 flex flex-wrap gap-3">
					{assets.map((asset) => (
						<div
							key={asset.filename}
							className="group relative flex flex-col items-center gap-1"
						>
							{asset.isImage ? (
								<button
									type="button"
									onClick={() => setLightboxAsset(asset)}
									className="block w-24 h-24 rounded overflow-hidden border border-gray-200 dark:border-gray-700 hover:border-blue-400 transition-colors"
								>
									<img
										src={asset.url}
										alt={asset.originalName}
										className="w-full h-full object-cover"
									/>
								</button>
							) : (
								<a
									href={asset.url}
									target="_blank"
									rel="noopener noreferrer"
									className="flex flex-col items-center justify-center w-24 h-24 rounded border border-gray-200 dark:border-gray-700 hover:border-blue-400 transition-colors text-3xl bg-gray-50 dark:bg-gray-800"
								>
									{fileIcon(asset.originalName.split(".").pop() ?? "")}
								</a>
							)}
							<span
								className="text-xs text-gray-500 dark:text-gray-400 max-w-[96px] truncate text-center"
								title={asset.originalName}
							>
								{asset.originalName}
							</span>
							<span className="text-xs text-gray-400">{formatBytes(asset.size)}</span>
							<button
								type="button"
								onClick={() => deleteAsset(asset.filename)}
								className="absolute -top-1 -right-1 hidden group-hover:flex w-5 h-5 items-center justify-center rounded-full bg-red-500 text-white text-xs leading-none"
								title="Remove"
							>
								×
							</button>
						</div>
					))}
				</div>
			) : null}

			{lightboxAsset && (
				<AssetLightbox asset={lightboxAsset} onClose={() => setLightboxAsset(null)} />
			)}
		</div>
	);
};
