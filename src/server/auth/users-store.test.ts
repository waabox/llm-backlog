import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsersStore } from "./users-store.ts";

const TEST_DIR_PREFIX = join(tmpdir(), "backlog-users-store-test-");

describe("UsersStore", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await mkdtemp(TEST_DIR_PREFIX);
	});

	afterEach(async () => {
		try {
			await rm(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	it("parses users from a valid users.md file", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			[
				"---",
				"users:",
				"  - email: admin@example.com",
				"    name: Admin User",
				"    role: admin",
				"  - email: viewer@example.com",
				"    name: Viewer User",
				"    role: viewer",
				"---",
			].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const admin = store.findByEmail("admin@example.com");
		expect(admin).not.toBeNull();
		expect(admin?.email).toBe("admin@example.com");
		expect(admin?.name).toBe("Admin User");
		expect(admin?.role).toBe("admin");

		const viewer = store.findByEmail("viewer@example.com");
		expect(viewer).not.toBeNull();
		expect(viewer?.email).toBe("viewer@example.com");
		expect(viewer?.name).toBe("Viewer User");
		expect(viewer?.role).toBe("viewer");
	});

	it("returns null for an unknown email", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			["---", "users:", "  - email: known@example.com", "    name: Known User", "    role: admin", "---"].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const result = store.findByEmail("unknown@example.com");
		expect(result).toBeNull();
	});

	it("performs case-insensitive email lookup", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			["---", "users:", "  - email: Admin@Test.com", "    name: Admin User", "    role: admin", "---"].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const lower = store.findByEmail("admin@test.com");
		expect(lower).not.toBeNull();
		expect(lower?.email).toBe("Admin@Test.com");
		expect(lower?.role).toBe("admin");

		const upper = store.findByEmail("ADMIN@TEST.COM");
		expect(upper).not.toBeNull();
		expect(upper?.email).toBe("Admin@Test.com");
		expect(upper?.role).toBe("admin");
	});

	it("returns empty results when file does not exist", async () => {
		const filePath = join(testDir, "nonexistent.md");

		const store = new UsersStore(filePath);
		await store.load();

		const result = store.findByEmail("anyone@example.com");
		expect(result).toBeNull();
	});

	it("skips entries with missing required fields", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			[
				"---",
				"users:",
				"  - name: No Email User",
				"    role: admin",
				"  - email: no-name@example.com",
				"    role: viewer",
				"  - email: valid@example.com",
				"    name: Valid User",
				"    role: admin",
				"---",
			].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const noEmail = store.findByEmail("no-email@example.com");
		expect(noEmail).toBeNull();

		const noName = store.findByEmail("no-name@example.com");
		expect(noName).toBeNull();

		const valid = store.findByEmail("valid@example.com");
		expect(valid).not.toBeNull();
		expect(valid?.name).toBe("Valid User");
		expect(valid?.role).toBe("admin");
	});

	it("defaults invalid roles to viewer", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			[
				"---",
				"users:",
				"  - email: superadmin@example.com",
				"    name: Super Admin",
				"    role: superadmin",
				"  - email: norole@example.com",
				"    name: No Role",
				"    role: editor",
				"---",
			].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const superadmin = store.findByEmail("superadmin@example.com");
		expect(superadmin).not.toBeNull();
		expect(superadmin?.role).toBe("viewer");

		const editor = store.findByEmail("norole@example.com");
		expect(editor).not.toBeNull();
		expect(editor?.role).toBe("viewer");
	});

	it("parses apiKey field from user entries", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			[
				"---",
				"users:",
				"  - email: admin@example.com",
				"    name: Admin User",
				"    role: admin",
				"    apiKey: bkmd_admin123",
				"  - email: viewer@example.com",
				"    name: Viewer User",
				"    role: viewer",
				"    apiKey: bkmd_viewer456",
				"---",
			].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const admin = store.findByApiKey("bkmd_admin123");
		expect(admin).not.toBeNull();
		expect(admin?.email).toBe("admin@example.com");
		expect(admin?.role).toBe("admin");

		const viewer = store.findByApiKey("bkmd_viewer456");
		expect(viewer).not.toBeNull();
		expect(viewer?.email).toBe("viewer@example.com");
		expect(viewer?.role).toBe("viewer");
	});

	it("returns null for unknown API key", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			[
				"---",
				"users:",
				"  - email: admin@example.com",
				"    name: Admin User",
				"    role: admin",
				"    apiKey: bkmd_admin123",
				"---",
			].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		expect(store.findByApiKey("bkmd_unknown")).toBeNull();
		expect(store.findByApiKey("")).toBeNull();
	});

	it("handles users without apiKey field", async () => {
		const filePath = join(testDir, "users.md");
		await Bun.write(
			filePath,
			[
				"---",
				"users:",
				"  - email: no-key@example.com",
				"    name: No Key User",
				"    role: admin",
				"  - email: has-key@example.com",
				"    name: Has Key User",
				"    role: viewer",
				"    apiKey: bkmd_haskey789",
				"---",
			].join("\n"),
		);

		const store = new UsersStore(filePath);
		await store.load();

		const hasKey = store.findByApiKey("bkmd_haskey789");
		expect(hasKey).not.toBeNull();
		expect(hasKey?.email).toBe("has-key@example.com");

		const noKey = store.findByEmail("no-key@example.com");
		expect(noKey).not.toBeNull();
	});
});
