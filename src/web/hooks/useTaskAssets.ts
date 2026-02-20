import { useCallback, useEffect, useState } from "react";
import { ApiClient } from "../lib/api";

export interface AssetMetadata {
	filename: string;
	originalName: string;
	mimeType: string;
	size: number;
	url: string;
	isImage: boolean;
}

export function useTaskAssets(taskId: string | undefined) {
	const [assets, setAssets] = useState<AssetMetadata[]>([]);
	const [loading, setLoading] = useState(false);
	const [uploading, setUploading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const authHeader = useCallback((): Record<string, string> => {
		const token = ApiClient.getToken();
		return token ? { Authorization: `Bearer ${token}` } : {};
	}, []);

	const fetchAssets = useCallback(async () => {
		if (!taskId) return;
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/tasks/${taskId}/assets`, {
				headers: authHeader(),
			});
			if (!res.ok) throw new Error(`Failed to load assets: ${res.status}`);
			const data: AssetMetadata[] = await res.json();
			setAssets(data);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load assets");
		} finally {
			setLoading(false);
		}
	}, [taskId, authHeader]);

	useEffect(() => {
		fetchAssets();
	}, [fetchAssets]);

	const uploadAsset = useCallback(
		async (file: File): Promise<void> => {
			if (!taskId) return;
			setUploading(true);
			setError(null);
			try {
				const form = new FormData();
				form.append("file", file);
				const res = await fetch(`/api/tasks/${taskId}/assets`, {
					method: "POST",
					headers: authHeader(),
					body: form,
				});
				if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
				await fetchAssets();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Upload failed");
			} finally {
				setUploading(false);
			}
		},
		[taskId, fetchAssets, authHeader],
	);

	const deleteAsset = useCallback(
		async (filename: string): Promise<void> => {
			if (!taskId) return;
			setError(null);
			try {
				const res = await fetch(`/api/tasks/${taskId}/assets/${encodeURIComponent(filename)}`, {
					method: "DELETE",
					headers: authHeader(),
				});
				if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
				setAssets((prev) => prev.filter((a) => a.filename !== filename));
			} catch (err) {
				setError(err instanceof Error ? err.message : "Delete failed");
			}
		},
		[taskId, authHeader],
	);

	return { assets, loading, uploading, error, uploadAsset, deleteAsset, refetch: fetchAssets };
}
