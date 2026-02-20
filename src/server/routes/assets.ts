import type { Core } from "../../core/backlog.ts";

export async function handleListAssets(taskId: string, core: Core): Promise<Response> {
	try {
		const assets = await core.filesystem.assets.listAssets(taskId);
		return Response.json(assets);
	} catch (error) {
		console.error("Error listing assets:", error);
		return Response.json({ error: "Failed to list assets" }, { status: 500 });
	}
}

export async function handleUploadAsset(req: Request, taskId: string, core: Core): Promise<Response> {
	try {
		const formData = await req.formData();
		const file = formData.get("file");
		if (!file || !(file instanceof File)) {
			return Response.json({ error: "No file provided" }, { status: 400 });
		}

		const buffer = await file.arrayBuffer();
		const metadata = await core.filesystem.assets.saveAsset(taskId, file.name, buffer);

		const config = await core.filesystem.loadConfig();
		if (config?.autoCommit) {
			const filePath = core.filesystem.assets.getAssetPath(taskId, metadata.filename);
			await core.git.commitFiles(`Add asset ${metadata.originalName} to ${taskId}`, [filePath]);
		}

		return Response.json(metadata, { status: 201 });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Upload failed";
		console.error("Error uploading asset:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}

export async function handleDeleteAsset(taskId: string, filename: string, core: Core): Promise<Response> {
	try {
		const filePath = core.filesystem.assets.getAssetPath(taskId, filename);
		await core.filesystem.assets.deleteAsset(taskId, filename);

		const config = await core.filesystem.loadConfig();
		if (config?.autoCommit) {
			await core.git.commitFiles(`Remove asset ${filename} from ${taskId}`, [filePath]);
		}

		return Response.json({ success: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : "Delete failed";
		console.error("Error deleting asset:", error);
		return Response.json({ error: message }, { status: 500 });
	}
}
