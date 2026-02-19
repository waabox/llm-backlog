import { mkdir } from "node:fs/promises";

/**
 * Remove path-unsafe characters and noisy punctuation, then normalize whitespace to hyphens.
 */
export const sanitizeFilename = (filename: string): string => {
	return (
		filename
			.replace(/[<>:"/\\|?*]/g, "-")
			// biome-ignore lint/complexity/noUselessEscapeInRegex: we need explicit escapes inside the character class
			.replace(/['(),!@#$%^&+=\[\]{};]/g, "")
			.replace(/\s+/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
	);
};

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export const ensureDirectoryExists = async (dirPath: string): Promise<void> => {
	try {
		await mkdir(dirPath, { recursive: true });
	} catch (_error) {
		// Directory creation failed, ignore
	}
};
