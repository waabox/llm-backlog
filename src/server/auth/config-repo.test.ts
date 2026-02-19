import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { ConfigRepoService } from "./config-repo";

describe("ConfigRepoService", () => {
	let remoteDir: string;

	beforeEach(async () => {
		remoteDir = await mkdtemp(join(tmpdir(), "config-repo-remote-"));
		await $`git init ${remoteDir}`.quiet();
		await $`git -C ${remoteDir} config user.email "test@test.com"`.quiet();
		await $`git -C ${remoteDir} config user.name "Test"`.quiet();

		const content = ["---", "users:", "  - email: admin@test.com", "    name: Admin", "    role: admin", "---"].join(
			"\n",
		);
		await writeFile(join(remoteDir, "users.md"), content);
		await $`git -C ${remoteDir} add .`.quiet();
		await $`git -C ${remoteDir} commit -m "init"`.quiet();
	});

	afterEach(async () => {
		await rm(remoteDir, { recursive: true, force: true });
	});

	it("clones the repo and loads users on start", async () => {
		const service = new ConfigRepoService(remoteDir);
		await service.start();

		const user = service.findUserByEmail("admin@test.com");
		expect(user).not.toBeNull();
		expect(user?.email).toBe("admin@test.com");
		expect(user?.name).toBe("Admin");
		expect(user?.role).toBe("admin");

		await service.stop();
	});

	it("returns null for unknown users", async () => {
		const service = new ConfigRepoService(remoteDir);
		await service.start();

		expect(service.findUserByEmail("nobody@test.com")).toBeNull();

		await service.stop();
	});

	it("finds a user by API key", async () => {
		// Write users.md with apiKey field to the remote git repo
		const usersContent = [
			"---",
			"users:",
			"  - email: admin@example.com",
			"    name: Admin User",
			"    role: admin",
			"    apiKey: bkmd_testapikey123",
			"---",
		].join("\n");

		await Bun.write(join(remoteDir, "users.md"), usersContent);
		await $`git -C ${remoteDir} add users.md && git -C ${remoteDir} commit -m "add users with apiKey"`.quiet();

		const service = new ConfigRepoService(remoteDir);
		await service.start();
		try {
			const user = service.findUserByApiKey("bkmd_testapikey123");
			expect(user).not.toBeNull();
			expect(user?.email).toBe("admin@example.com");
			expect(user?.role).toBe("admin");

			const unknown = service.findUserByApiKey("bkmd_unknown");
			expect(unknown).toBeNull();
		} finally {
			await service.stop();
		}
	});

	it("reloads users after pull", async () => {
		const service = new ConfigRepoService(remoteDir);
		await service.start();

		// Add a new user to the remote repo
		const newContent = [
			"---",
			"users:",
			"  - email: admin@test.com",
			"    name: Admin",
			"    role: admin",
			"  - email: new@test.com",
			"    name: New User",
			"    role: viewer",
			"---",
		].join("\n");
		await writeFile(join(remoteDir, "users.md"), newContent);
		await $`git -C ${remoteDir} add .`.quiet();
		await $`git -C ${remoteDir} commit -m "add user"`.quiet();

		await service.pull();

		const newUser = service.findUserByEmail("new@test.com");
		expect(newUser).not.toBeNull();
		expect(newUser?.email).toBe("new@test.com");
		expect(newUser?.name).toBe("New User");
		expect(newUser?.role).toBe("viewer");

		// Original user should still be present
		expect(service.findUserByEmail("admin@test.com")).not.toBeNull();

		await service.stop();
	});
});
