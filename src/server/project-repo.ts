import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";

/**
 * Manages a local clone of a remote project repo.
 * Clones the repository on start and cleans up on stop.
 * No polling — mutations commit locally to the clone.
 *
 * @author waabox(waabox[at]gmail[dot]com)
 */
export class ProjectRepoService {
	private localDir: string | null = null;

	constructor(private readonly repoUrl: string) {}

	/**
	 * Clones the remote project repo into a temporary directory.
	 */
	async start(): Promise<void> {
		if (this.localDir !== null) {
			throw new Error("ProjectRepoService is already running");
		}
		this.localDir = await mkdtemp(join(tmpdir(), "backlog-project-"));
		console.log(`[ProjectRepo] Cloning ${this.repoUrl} into ${this.localDir}`);
		await $`git clone ${this.repoUrl} ${this.localDir}`.quiet();
	}

	/**
	 * Returns the path to the local clone.
	 *
	 * @throws If the service has not been started
	 */
	get dir(): string {
		if (!this.localDir) throw new Error("ProjectRepoService not started");
		return this.localDir;
	}

	/**
	 * Removes the temporary clone directory.
	 */
	async stop(): Promise<void> {
		if (this.localDir) {
			await rm(this.localDir, { recursive: true, force: true }).catch(() => {});
			this.localDir = null;
		}
	}
}
