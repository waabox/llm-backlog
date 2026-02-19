import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { type AuthUser, UsersStore } from "./users-store";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages a local clone of a config repo that contains users.md.
 * Clones the repository on start, polls for updates on a fixed interval,
 * and exposes user lookups via a UsersStore.
 *
 * @author waabox(waabox[at]gmail[dot]com)
 */
export class ConfigRepoService {
	private localDir: string | null = null;
	private usersStore: UsersStore | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly repoUrl: string) {}

	/**
	 * Clones the config repo into a temporary directory, initializes the
	 * UsersStore from the cloned users.md, and starts the poll timer.
	 */
	async start(): Promise<void> {
		if (this.localDir !== null) {
			throw new Error("ConfigRepoService is already running");
		}
		this.localDir = await mkdtemp(join(tmpdir(), "backlog-config-"));
		await $`git clone ${this.repoUrl} ${this.localDir}`.quiet();

		this.usersStore = new UsersStore(join(this.localDir, "users.md"));
		await this.usersStore.load();

		this.pollTimer = setInterval(() => {
			this.pull().catch((err) => console.error("Config repo poll error:", err));
		}, POLL_INTERVAL_MS);
	}

	/**
	 * Pulls the latest changes from the remote and reloads the UsersStore.
	 * No-op if the service has not been started.
	 */
	async pull(): Promise<void> {
		if (!this.localDir || !this.usersStore) {
			return;
		}
		await $`git -C ${this.localDir} pull --ff-only`.quiet();
		await this.usersStore.load();
	}

	/**
	 * Looks up a user by email address.
	 *
	 * @param email The email to search for
	 * @returns The matching AuthUser or null if not found or service not started
	 */
	findUserByEmail(email: string): AuthUser | null {
		return this.usersStore?.findByEmail(email) ?? null;
	}

	/**
	 * Looks up a user by API key.
	 *
	 * @param apiKey The API key to search for
	 * @returns The matching AuthUser or null if not found or service not started
	 */
	findUserByApiKey(apiKey: string): AuthUser | null {
		return this.usersStore?.findByApiKey(apiKey) ?? null;
	}

	/**
	 * Returns all users from the config repo.
	 *
	 * @returns Array of all AuthUser entries, or empty array if not started
	 */
	listUsers(): AuthUser[] {
		return this.usersStore?.listAll() ?? [];
	}

	/**
	 * Stops the poll timer and removes the temporary clone directory.
	 */
	async stop(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
		if (this.localDir) {
			await rm(this.localDir, { recursive: true, force: true }).catch(() => {});
			this.localDir = null;
		}
		this.usersStore = null;
	}
}
