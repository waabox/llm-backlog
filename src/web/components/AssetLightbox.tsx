import React, { useEffect } from "react";
import type { AssetMetadata } from "../hooks/useTaskAssets";

interface Props {
	asset: AssetMetadata;
	onClose: () => void;
}

export const AssetLightbox: React.FC<Props> = ({ asset, onClose }) => {
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
			onClick={onClose}
		>
			<div
				className="relative max-w-4xl max-h-screen p-4 flex flex-col items-center"
				onClick={(e) => e.stopPropagation()}
			>
				<img
					src={asset.url}
					alt={asset.originalName}
					className="max-h-[80vh] max-w-full object-contain rounded shadow-lg"
				/>
				<div className="mt-3 flex items-center gap-4">
					<span className="text-white text-sm">{asset.originalName}</span>
					<a
						href={asset.url}
						target="_blank"
						rel="noopener noreferrer"
						className="px-3 py-1 text-sm bg-white text-gray-900 rounded hover:bg-gray-100 transition-colors"
					>
						Full-Size
					</a>
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1 text-sm bg-gray-700 text-white rounded hover:bg-gray-600 transition-colors"
					>
						Close
					</button>
				</div>
			</div>
		</div>
	);
};
