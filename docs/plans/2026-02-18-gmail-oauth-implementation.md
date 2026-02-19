# Gmail OAuth Authentication - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add opt-in Google OAuth login to the Backlog.md web UI with role-based access control (admin/viewer), using a separate private Git repo for user whitelist.

**Architecture:** Google Sign-In popup on the frontend sends an `id_token` to the server, which validates it with Google, checks the email against `users.md` (cloned from a private config repo), and returns a JWT. The JWT is stored in localStorage and sent as a Bearer token on all API requests. Auth is opt-in: no env vars = no auth.

**Tech Stack:** Bun runtime, `gray-matter` (already installed) for YAML parsing, HMAC-SHA256 for JWT signing (no external JWT library — Bun's `crypto` suffices), Google Sign-In SDK loaded dynamically on the frontend.

---

## Task 1: JWT Utility Module

Creates a minimal JWT sign/verify module using Bun's native crypto (no dependencies).

**Files:**
- Create: `src/server/auth/jwt.ts`
- Create: `src/server/auth/jwt.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/auth/jwt.test.ts
import { describe, expect, it } from "bun:test";
import { signJwt, verifyJwt } from "./jwt";

describe("JWT", () => {
	const secret = "test-secret-key-for-jwt";

	describe("signJwt", () => {
		it("returns a string with three dot-separated parts", () => {
			const token = signJwt({ email: "a@b.com", name: "A", role: "admin" }, secret, 3600);
			const parts = token.split(".");
			expect(parts.length).toBe(3);
		});
	});

	describe("verifyJwt", () => {
		it("returns the payload for a valid token", () => {
			const token = signJwt({ email: "a@b.com", name: "A", role: "admin" }, secret, 3600);
			const payload = verifyJwt(token, secret);
			expect(payload).not.toBeNull();
			expect(payload!.email).toBe("a@b.com");
			expect(payload!.name).toBe("A");
			expect(payload!.role).toBe("admin");
		});

		it("returns null for an expired token", () => {
			const token = signJwt({ email: "a@b.com", name: "A", role: "admin" }, secret, -1);
			const payload = verifyJwt(token, secret);
			expect(payload).toBeNull();
		});

		it("returns null for a token signed with a different secret", () => {
			const token = signJwt({ email: "a@b.com", name: "A", role: "admin" }, "wrong-secret", 3600);
			const payload = verifyJwt(token, secret);
			expect(payload).toBeNull();
		});

		it("returns null for a malformed token", () => {
			expect(verifyJwt("not.a.jwt", secret)).toBeNull();
			expect(verifyJwt("", secret)).toBeNull();
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/server/auth/jwt.test.ts`
Expected: FAIL — module `./jwt` not found

**Step 3: Write minimal implementation**

```typescript
// src/server/auth/jwt.ts

export interface JwtPayload {
	email: string;
	name: string;
	role: string;
	iat: number;
	exp: number;
}

function base64UrlEncode(data: Uint8Array | string): string {
	const input = typeof data === "string" ? new TextEncoder().encode(data) : data;
	return btoa(String.fromCharCode(...input))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64UrlDecode(str: string): string {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/");
	const paddedWithEquals = padded + "=".repeat((4 - (padded.length % 4)) % 4);
	return atob(paddedWithEquals);
}

async function hmacSign(data: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return base64UrlEncode(new Uint8Array(signature));
}

/**
 * Sign a JWT with HMAC-SHA256.
 * @param payload User data to encode (email, name, role)
 * @param secret HMAC secret key
 * @param expiresInSeconds Token lifetime in seconds
 */
export function signJwt(
	payload: { email: string; name: string; role: string },
	secret: string,
	expiresInSeconds: number,
): string {
	const now = Math.floor(Date.now() / 1000);
	const fullPayload: JwtPayload = {
		...payload,
		iat: now,
		exp: now + expiresInSeconds,
	};

	const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = base64UrlEncode(JSON.stringify(fullPayload));
	const data = `${header}.${body}`;

	// Use synchronous approach: pre-compute HMAC via Bun's crypto
	const hmac = new Bun.CryptoHasher("sha256", secret);
	hmac.update(data);
	const signature = base64UrlEncode(new Uint8Array(hmac.digest() as ArrayBuffer));

	return `${data}.${signature}`;
}

/**
 * Verify a JWT signed with HMAC-SHA256.
 * Returns the payload if valid and not expired, null otherwise.
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) return null;

	const [header, body, signature] = parts;
	const data = `${header}.${body}`;

	// Recompute signature
	const hmac = new Bun.CryptoHasher("sha256", secret);
	hmac.update(data);
	const expectedSignature = base64UrlEncode(new Uint8Array(hmac.digest() as ArrayBuffer));

	if (signature !== expectedSignature) return null;

	try {
		const payload = JSON.parse(base64UrlDecode(body!)) as JwtPayload;
		const now = Math.floor(Date.now() / 1000);
		if (payload.exp <= now) return null;
		return payload;
	} catch {
		return null;
	}
}
```

> **Note:** Uses `Bun.CryptoHasher` for synchronous HMAC-SHA256 — no async needed, no npm dependencies.

**Step 4: Run test to verify it passes**

Run: `bun test src/server/auth/jwt.test.ts`
Expected: All 5 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/jwt.ts src/server/auth/jwt.test.ts
git commit -m "Add JWT sign/verify utility using Bun CryptoHasher"
```

---

## Task 2: Users Store — Parse users.md from a Local Path

Parses `users.md` YAML frontmatter into a user list. Decoupled from git — just reads a file path.

**Files:**
- Create: `src/server/auth/users-store.ts`
- Create: `src/server/auth/users-store.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/auth/users-store.test.ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UsersStore } from "./users-store";

describe("UsersStore", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "users-store-test-"));
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("parses users from a valid users.md file", async () => {
		const content = [
			"---",
			"users:",
			"  - email: admin@test.com",
			"    name: Admin",
			"    role: admin",
			"  - email: viewer@test.com",
			"    name: Viewer",
			"    role: viewer",
			"---",
		].join("\n");
		await writeFile(join(tempDir, "users.md"), content);

		const store = new UsersStore(join(tempDir, "users.md"));
		await store.load();

		expect(store.findByEmail("admin@test.com")).toEqual({
			email: "admin@test.com",
			name: "Admin",
			role: "admin",
		});
		expect(store.findByEmail("viewer@test.com")).toEqual({
			email: "viewer@test.com",
			name: "Viewer",
			role: "viewer",
		});
	});

	it("returns null for an unknown email", async () => {
		const content = "---\nusers:\n  - email: a@b.com\n    name: A\n    role: admin\n---";
		await writeFile(join(tempDir, "users.md"), content);

		const store = new UsersStore(join(tempDir, "users.md"));
		await store.load();

		expect(store.findByEmail("unknown@test.com")).toBeNull();
	});

	it("is case-insensitive for email lookup", async () => {
		const content = "---\nusers:\n  - email: Admin@Test.com\n    name: A\n    role: admin\n---";
		await writeFile(join(tempDir, "users.md"), content);

		const store = new UsersStore(join(tempDir, "users.md"));
		await store.load();

		expect(store.findByEmail("admin@test.com")).not.toBeNull();
		expect(store.findByEmail("ADMIN@TEST.COM")).not.toBeNull();
	});

	it("returns empty list when file does not exist", async () => {
		const store = new UsersStore(join(tempDir, "nonexistent.md"));
		await store.load();

		expect(store.findByEmail("a@b.com")).toBeNull();
	});

	it("skips entries with missing required fields", async () => {
		const content = [
			"---",
			"users:",
			"  - email: valid@test.com",
			"    name: Valid",
			"    role: admin",
			"  - name: NoEmail",
			"    role: admin",
			"  - email: norole@test.com",
			"    name: NoRole",
			"---",
		].join("\n");
		await writeFile(join(tempDir, "users.md"), content);

		const store = new UsersStore(join(tempDir, "users.md"));
		await store.load();

		expect(store.findByEmail("valid@test.com")).not.toBeNull();
		expect(store.findByEmail("norole@test.com")).toBeNull();
	});

	it("defaults invalid roles to viewer", async () => {
		const content = "---\nusers:\n  - email: a@b.com\n    name: A\n    role: superadmin\n---";
		await writeFile(join(tempDir, "users.md"), content);

		const store = new UsersStore(join(tempDir, "users.md"));
		await store.load();

		expect(store.findByEmail("a@b.com")?.role).toBe("viewer");
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/server/auth/users-store.test.ts`
Expected: FAIL — module `./users-store` not found

**Step 3: Write minimal implementation**

```typescript
// src/server/auth/users-store.ts
import matter from "gray-matter";

export interface AuthUser {
	email: string;
	name: string;
	role: "admin" | "viewer";
}

/**
 * Reads and parses a users.md file with YAML frontmatter.
 * Provides email-based lookup for the user whitelist.
 */
export class UsersStore {
	private users = new Map<string, AuthUser>();

	constructor(private readonly filePath: string) {}

	/** Load (or reload) users from the file. */
	async load(): Promise<void> {
		this.users.clear();

		const file = Bun.file(this.filePath);
		if (!(await file.exists())) return;

		const raw = await file.text();
		const { data } = matter(raw);

		if (!Array.isArray(data.users)) return;

		for (const entry of data.users) {
			if (!entry || typeof entry.email !== "string" || typeof entry.name !== "string") continue;
			if (typeof entry.role !== "string") continue;

			const role = entry.role === "admin" ? "admin" : "viewer";
			const email = entry.email.trim().toLowerCase();
			if (!email) continue;

			this.users.set(email, { email: entry.email.trim(), name: entry.name.trim(), role });
		}
	}

	/** Find a user by email (case-insensitive). Returns null if not found. */
	findByEmail(email: string): AuthUser | null {
		return this.users.get(email.toLowerCase()) ?? null;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/server/auth/users-store.test.ts`
Expected: All 6 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/users-store.ts src/server/auth/users-store.test.ts
git commit -m "Add UsersStore to parse users.md YAML frontmatter"
```

---

## Task 3: Config Repo Service — Clone, Poll, Reload

Clones the config repo on startup, polls for changes, and exposes the UsersStore.

**Files:**
- Create: `src/server/auth/config-repo.ts`
- Create: `src/server/auth/config-repo.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/auth/config-repo.test.ts
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { ConfigRepoService } from "./config-repo";

describe("ConfigRepoService", () => {
	let remoteDir: string;

	beforeEach(async () => {
		// Create a fake "remote" git repo with users.md
		remoteDir = await mkdtemp(join(tmpdir(), "config-repo-remote-"));
		await $`git init ${remoteDir}`.quiet();
		await $`git -C ${remoteDir} config user.email "test@test.com"`.quiet();
		await $`git -C ${remoteDir} config user.name "Test"`.quiet();

		const content = [
			"---",
			"users:",
			"  - email: admin@test.com",
			"    name: Admin",
			"    role: admin",
			"---",
		].join("\n");
		await writeFile(join(remoteDir, "users.md"), content);
		await $`git -C ${remoteDir} add . && git -C ${remoteDir} commit -m "init"`.quiet();
	});

	afterEach(async () => {
		await rm(remoteDir, { recursive: true, force: true });
	});

	it("clones the repo and loads users on start", async () => {
		const service = new ConfigRepoService(remoteDir);
		await service.start();

		expect(service.findUserByEmail("admin@test.com")).not.toBeNull();
		expect(service.findUserByEmail("admin@test.com")?.role).toBe("admin");

		await service.stop();
	});

	it("returns null for unknown users", async () => {
		const service = new ConfigRepoService(remoteDir);
		await service.start();

		expect(service.findUserByEmail("nobody@test.com")).toBeNull();

		await service.stop();
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
		await $`git -C ${remoteDir} add . && git -C ${remoteDir} commit -m "add user"`.quiet();

		// Force a pull + reload
		await service.pull();

		expect(service.findUserByEmail("new@test.com")).not.toBeNull();
		expect(service.findUserByEmail("new@test.com")?.role).toBe("viewer");

		await service.stop();
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/server/auth/config-repo.test.ts`
Expected: FAIL — module `./config-repo` not found

**Step 3: Write minimal implementation**

```typescript
// src/server/auth/config-repo.ts
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { $ } from "bun";
import { UsersStore, type AuthUser } from "./users-store";

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Manages a local clone of the config repo containing users.md.
 * Clones on start, polls for updates, and exposes user lookups.
 */
export class ConfigRepoService {
	private localDir: string | null = null;
	private usersStore: UsersStore | null = null;
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(private readonly repoUrl: string) {}

	/** Clone the repo and load users. Starts the poll timer. */
	async start(): Promise<void> {
		this.localDir = await mkdtemp(join(tmpdir(), "backlog-config-"));
		await $`git clone ${this.repoUrl} ${this.localDir}`.quiet();

		this.usersStore = new UsersStore(join(this.localDir, "users.md"));
		await this.usersStore.load();

		this.pollTimer = setInterval(() => {
			this.pull().catch((err) => console.error("Config repo poll error:", err));
		}, POLL_INTERVAL_MS);
	}

	/** Pull latest changes and reload users. */
	async pull(): Promise<void> {
		if (!this.localDir || !this.usersStore) return;
		await $`git -C ${this.localDir} pull --ff-only`.quiet();
		await this.usersStore.load();
	}

	/** Find a user by email. Returns null if not found or service not started. */
	findUserByEmail(email: string): AuthUser | null {
		return this.usersStore?.findByEmail(email) ?? null;
	}

	/** Stop polling and clean up the temp directory. */
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
```

**Step 4: Run test to verify it passes**

Run: `bun test src/server/auth/config-repo.test.ts`
Expected: All 3 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/config-repo.ts src/server/auth/config-repo.test.ts
git commit -m "Add ConfigRepoService for config repo clone and poll"
```

---

## Task 4: Google Token Verification

Validates Google `id_token` by fetching Google's public keys and verifying the JWT signature.

**Files:**
- Create: `src/server/auth/google-verify.ts`
- Create: `src/server/auth/google-verify.test.ts`

**Step 1: Write the failing test**

```typescript
// src/server/auth/google-verify.test.ts
import { describe, expect, it } from "bun:test";
import { verifyGoogleToken } from "./google-verify";

describe("verifyGoogleToken", () => {
	it("returns null for a completely invalid token", async () => {
		const result = await verifyGoogleToken("not-a-real-token", "some-client-id");
		expect(result).toBeNull();
	});

	it("returns null for an empty string", async () => {
		const result = await verifyGoogleToken("", "some-client-id");
		expect(result).toBeNull();
	});
});
```

> Note: Full integration tests with real Google tokens are not practical in unit tests. We test the error paths. The real validation is done using Google's tokeninfo endpoint.

**Step 2: Run test to verify it fails**

Run: `bun test src/server/auth/google-verify.test.ts`
Expected: FAIL — module `./google-verify` not found

**Step 3: Write minimal implementation**

```typescript
// src/server/auth/google-verify.ts

interface GoogleTokenPayload {
	email: string;
	name: string;
	picture?: string;
	email_verified: boolean;
	aud: string;
	sub: string;
}

const GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";

/**
 * Verify a Google id_token using Google's tokeninfo endpoint.
 * Returns the decoded payload if valid, null otherwise.
 *
 * @param idToken The id_token from Google Sign-In
 * @param clientId The expected GOOGLE_CLIENT_ID (audience)
 */
export async function verifyGoogleToken(
	idToken: string,
	clientId: string,
): Promise<{ email: string; name: string } | null> {
	if (!idToken) return null;

	try {
		const response = await fetch(`${GOOGLE_TOKEN_INFO_URL}?id_token=${encodeURIComponent(idToken)}`);
		if (!response.ok) return null;

		const payload = (await response.json()) as GoogleTokenPayload;

		// Verify audience matches our client ID
		if (payload.aud !== clientId) return null;

		// Verify email is present and verified
		if (!payload.email || !payload.email_verified) return null;

		return {
			email: payload.email,
			name: payload.name || payload.email,
		};
	} catch {
		return null;
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/server/auth/google-verify.test.ts`
Expected: All 2 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/google-verify.ts src/server/auth/google-verify.test.ts
git commit -m "Add Google id_token verification via tokeninfo endpoint"
```

---

## Task 5: Auth Middleware and Auth Routes

Wire auth into BacklogServer: add `/api/auth/*` routes and request-level auth/role checking.

**Files:**
- Create: `src/server/auth/middleware.ts`
- Create: `src/server/auth/middleware.test.ts`
- Modify: `src/server/index.ts` (add auth routes, apply middleware in `fetch` handler)

**Step 1: Write the failing test for middleware**

```typescript
// src/server/auth/middleware.test.ts
import { describe, expect, it } from "bun:test";
import { extractBearerToken, isPublicRoute, isWriteMethod } from "./middleware";

describe("Auth middleware helpers", () => {
	describe("extractBearerToken", () => {
		it("extracts token from valid Authorization header", () => {
			expect(extractBearerToken("Bearer abc123")).toBe("abc123");
		});

		it("returns null for missing header", () => {
			expect(extractBearerToken(null)).toBeNull();
		});

		it("returns null for non-Bearer scheme", () => {
			expect(extractBearerToken("Basic abc123")).toBeNull();
		});
	});

	describe("isPublicRoute", () => {
		it("marks auth routes as public", () => {
			expect(isPublicRoute("/api/auth/status")).toBe(true);
			expect(isPublicRoute("/api/auth/google")).toBe(true);
		});

		it("marks other API routes as non-public", () => {
			expect(isPublicRoute("/api/tasks")).toBe(false);
			expect(isPublicRoute("/api/config")).toBe(false);
		});

		it("marks non-API routes as public (SPA routes)", () => {
			expect(isPublicRoute("/tasks")).toBe(true);
			expect(isPublicRoute("/")).toBe(true);
		});
	});

	describe("isWriteMethod", () => {
		it("identifies write methods", () => {
			expect(isWriteMethod("POST")).toBe(true);
			expect(isWriteMethod("PUT")).toBe(true);
			expect(isWriteMethod("DELETE")).toBe(true);
		});

		it("identifies read methods", () => {
			expect(isWriteMethod("GET")).toBe(false);
			expect(isWriteMethod("HEAD")).toBe(false);
		});
	});
});
```

**Step 2: Run test to verify it fails**

Run: `bun test src/server/auth/middleware.test.ts`
Expected: FAIL — module not found

**Step 3: Write middleware helpers**

```typescript
// src/server/auth/middleware.ts
import { verifyJwt, type JwtPayload } from "./jwt";

const PUBLIC_ROUTES = new Set(["/api/auth/status", "/api/auth/google"]);

/** Extract Bearer token from Authorization header value. */
export function extractBearerToken(headerValue: string | null): string | null {
	if (!headerValue) return null;
	if (!headerValue.startsWith("Bearer ")) return null;
	return headerValue.slice(7);
}

/** Check if the route does not require authentication. */
export function isPublicRoute(pathname: string): boolean {
	if (PUBLIC_ROUTES.has(pathname)) return true;
	if (!pathname.startsWith("/api/")) return true;
	return false;
}

/** Check if the HTTP method is a write operation. */
export function isWriteMethod(method: string): boolean {
	return method === "POST" || method === "PUT" || method === "DELETE";
}

/**
 * Authenticate a request. Returns the JWT payload if valid, or a Response to send back (401/403).
 * If auth is disabled, returns null (pass through).
 */
export function authenticateRequest(
	req: Request,
	authEnabled: boolean,
	jwtSecret: string,
): { payload: JwtPayload | null; errorResponse: Response | null } {
	const url = new URL(req.url);

	if (!authEnabled || isPublicRoute(url.pathname)) {
		return { payload: null, errorResponse: null };
	}

	const token = extractBearerToken(req.headers.get("authorization"));
	if (!token) {
		return {
			payload: null,
			errorResponse: Response.json({ error: "Authentication required" }, { status: 401 }),
		};
	}

	const payload = verifyJwt(token, jwtSecret);
	if (!payload) {
		return {
			payload: null,
			errorResponse: Response.json({ error: "Invalid or expired token" }, { status: 401 }),
		};
	}

	// Role check: viewers cannot use write methods
	if (payload.role === "viewer" && isWriteMethod(req.method)) {
		return {
			payload,
			errorResponse: Response.json({ error: "Insufficient permissions" }, { status: 403 }),
		};
	}

	return { payload, errorResponse: null };
}
```

**Step 4: Run test to verify it passes**

Run: `bun test src/server/auth/middleware.test.ts`
Expected: All 7 tests PASS

**Step 5: Commit**

```bash
git add src/server/auth/middleware.ts src/server/auth/middleware.test.ts
git commit -m "Add auth middleware with JWT verification and role checking"
```

---

## Task 6: Wire Auth Into BacklogServer

Integrate all auth modules into the server: config repo lifecycle, auth routes, and middleware.

**Files:**
- Modify: `src/server/index.ts`
- Create: `src/server/auth/index.ts` (barrel export)

**Step 1: Create barrel export**

```typescript
// src/server/auth/index.ts
export { signJwt, verifyJwt, type JwtPayload } from "./jwt";
export { UsersStore, type AuthUser } from "./users-store";
export { ConfigRepoService } from "./config-repo";
export { verifyGoogleToken } from "./google-verify";
export { authenticateRequest, extractBearerToken, isPublicRoute, isWriteMethod } from "./middleware";
```

**Step 2: Modify `src/server/index.ts`**

Add the following to `BacklogServer`:

1. **New private fields** (after existing fields around line 84):

```typescript
private configRepoService: ConfigRepoService | null = null;
private authEnabled = false;
private jwtSecret: string;
private googleClientId: string | null = null;
```

2. **Initialize auth in `start()` method** (after `this.configWatcher` setup, around line 295):

```typescript
// Initialize auth if environment variables are configured
this.googleClientId = process.env.GOOGLE_CLIENT_ID ?? null;
const authConfigRepo = process.env.AUTH_CONFIG_REPO ?? null;
this.jwtSecret = process.env.JWT_SECRET ?? crypto.randomUUID();

if (this.googleClientId && authConfigRepo) {
	this.authEnabled = true;
	this.configRepoService = new ConfigRepoService(authConfigRepo);
	await this.configRepoService.start();
	console.log("🔐 Authentication enabled (Google OAuth)");
} else {
	console.log("🔓 Authentication disabled (set GOOGLE_CLIENT_ID and AUTH_CONFIG_REPO to enable)");
}
```

3. **Add auth routes to the `routes` object** (after existing routes, before `"/assets/*"`):

```typescript
"/api/auth/status": {
	GET: async () => {
		return Response.json({
			enabled: this.authEnabled,
			clientId: this.authEnabled ? this.googleClientId : undefined,
		});
	},
},
"/api/auth/google": {
	POST: async (req: Request) => await this.handleGoogleLogin(req),
},
"/api/auth/me": {
	GET: async (req: Request) => await this.handleGetMe(req),
},
```

4. **Add auth check in `fetch` handler** (in the `fetch:` callback, before the existing logic around line 420):

```typescript
fetch: async (req: Request, server: Server<unknown>) => {
	// Auth middleware check
	const { errorResponse } = authenticateRequest(req, this.authEnabled, this.jwtSecret);
	if (errorResponse) {
		return errorResponse;
	}

	const res = await this.handleRequest(req, server);
	// ... rest of existing fetch handler
},
```

5. **Stop config repo in `stop()` method** (after config watcher stop, around line 500):

```typescript
try {
	await this.configRepoService?.stop();
	this.configRepoService = null;
} catch {}
```

6. **Add handler methods** (at the end of the class, before the closing brace):

```typescript
private async handleGoogleLogin(req: Request): Promise<Response> {
	if (!this.authEnabled || !this.googleClientId || !this.configRepoService) {
		return Response.json({ error: "Authentication is not enabled" }, { status: 400 });
	}

	const body = await req.json();
	const credential = body?.credential;
	if (typeof credential !== "string" || !credential) {
		return Response.json({ error: "Missing credential" }, { status: 400 });
	}

	const googleUser = await verifyGoogleToken(credential, this.googleClientId);
	if (!googleUser) {
		return Response.json({ error: "Invalid Google token" }, { status: 401 });
	}

	const user = this.configRepoService.findUserByEmail(googleUser.email);
	if (!user) {
		return Response.json({ error: "Your account does not have access" }, { status: 403 });
	}

	const token = signJwt(
		{ email: user.email, name: user.name, role: user.role },
		this.jwtSecret,
		24 * 60 * 60, // 24 hours
	);

	return Response.json({ token, user: { email: user.email, name: user.name, role: user.role } });
}

private async handleGetMe(req: Request): Promise<Response> {
	const token = extractBearerToken(req.headers.get("authorization"));
	if (!token) {
		return Response.json({ error: "Not authenticated" }, { status: 401 });
	}

	const payload = verifyJwt(token, this.jwtSecret);
	if (!payload) {
		return Response.json({ error: "Invalid token" }, { status: 401 });
	}

	return Response.json({ email: payload.email, name: payload.name, role: payload.role });
}
```

7. **Add imports at the top of the file:**

```typescript
import { ConfigRepoService } from "./auth/config-repo";
import { signJwt, verifyJwt } from "./auth/jwt";
import { verifyGoogleToken } from "./auth/google-verify";
import { authenticateRequest, extractBearerToken } from "./auth/middleware";
```

**Step 3: Run the full test suite**

Run: `CLAUDECODE=1 bun test --timeout 180000`
Expected: All existing tests still pass (no regressions). Auth is not activated without env vars.

**Step 4: Commit**

```bash
git add src/server/auth/index.ts src/server/index.ts
git commit -m "Wire auth into BacklogServer with opt-in OAuth routes and middleware"
```

---

## Task 7: Frontend Auth API Client Methods

Add auth-related methods to the API client and add auth headers to all requests.

**Files:**
- Modify: `src/web/lib/api.ts`

**Step 1: Add auth token storage and header injection**

In `src/web/lib/api.ts`, modify the `ApiClient` class:

1. **Add static token methods** (before the constructor):

```typescript
private static readonly TOKEN_KEY = "backlog-auth-token";

static getToken(): string | null {
	return localStorage.getItem(ApiClient.TOKEN_KEY);
}

static setToken(token: string): void {
	localStorage.setItem(ApiClient.TOKEN_KEY, token);
}

static clearToken(): void {
	localStorage.removeItem(ApiClient.TOKEN_KEY);
}
```

2. **Modify `fetchWithRetry`** to add auth header (in the headers spread, around line 82):

```typescript
headers: {
	"Content-Type": "application/json",
	...(ApiClient.getToken() ? { Authorization: `Bearer ${ApiClient.getToken()}` } : {}),
	...options.headers,
},
```

3. **Add 401 handling** in the error path (after `throw ApiError.fromResponse(response, errorData)`, around line 97):

Replace the existing error throw logic:

```typescript
if (!response.ok) {
	let errorData: unknown = null;
	try {
		errorData = await response.json();
	} catch {
		// Ignore JSON parse errors for error data
	}

	// Clear token and trigger re-auth on 401
	if (response.status === 401) {
		ApiClient.clearToken();
		window.dispatchEvent(new Event("auth:unauthorized"));
	}

	throw ApiError.fromResponse(response, errorData);
}
```

4. **Add auth API methods** (at the end of the class, before `apiClient` export):

```typescript
async fetchAuthStatus(): Promise<{ enabled: boolean; clientId?: string }> {
	const response = await fetch(`${API_BASE}/auth/status`);
	if (!response.ok) throw new Error("Failed to fetch auth status");
	return response.json();
}

async loginWithGoogle(credential: string): Promise<{ token: string; user: { email: string; name: string; role: string } }> {
	const response = await fetch(`${API_BASE}/auth/google`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ credential }),
	});
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new ApiError(data.error || "Login failed", response.status);
	}
	const result = await response.json();
	ApiClient.setToken(result.token);
	return result;
}

async fetchMe(): Promise<{ email: string; name: string; role: string }> {
	return this.fetchJson<{ email: string; name: string; role: string }>(`${API_BASE}/auth/me`);
}

logout(): void {
	ApiClient.clearToken();
	window.location.href = "/";
}
```

5. **Also add auth headers to the fetch calls that bypass `fetchWithRetry`** (e.g., `fetchStatuses`, `fetchConfig`, etc. that use raw `fetch`). Add a private helper:

```typescript
private authHeaders(): Record<string, string> {
	const token = ApiClient.getToken();
	return token ? { Authorization: `Bearer ${token}` } : {};
}
```

Then add `...this.authHeaders()` to the headers of all raw `fetch` calls in the class (fetchStatuses, fetchConfig, updateConfig, fetchDocs, fetchDoc, fetchDocument, updateDoc, createDoc, fetchDecisions, fetchDecision, fetchDecisionData, updateDecision, createDecision, fetchMilestones, fetchArchivedMilestones, fetchMilestone, createMilestone, archiveMilestone).

**Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/web/lib/api.ts
git commit -m "Add auth token management and auth headers to API client"
```

---

## Task 8: AuthContext Provider

Create the React context for auth state management.

**Files:**
- Create: `src/web/contexts/AuthContext.tsx`

**Step 1: Write the AuthContext**

```tsx
// src/web/contexts/AuthContext.tsx
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { apiClient, ApiClient } from "../lib/api";

interface AuthUser {
	email: string;
	name: string;
	role: string;
}

interface AuthContextType {
	user: AuthUser | null;
	isLoading: boolean;
	isAuthEnabled: boolean;
	login: (credential: string) => Promise<void>;
	logout: () => void;
	error: string | null;
	clearError: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [user, setUser] = useState<AuthUser | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [isAuthEnabled, setIsAuthEnabled] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const clearError = useCallback(() => setError(null), []);

	// Check auth status and validate existing token on mount
	useEffect(() => {
		let cancelled = false;

		(async () => {
			try {
				const status = await apiClient.fetchAuthStatus();
				if (cancelled) return;

				setIsAuthEnabled(status.enabled);

				if (!status.enabled) {
					setIsLoading(false);
					return;
				}

				// If we have a stored token, validate it
				if (ApiClient.getToken()) {
					try {
						const me = await apiClient.fetchMe();
						if (!cancelled) setUser(me);
					} catch {
						ApiClient.clearToken();
					}
				}
			} catch {
				// If we can't reach the server, auth status is unknown — treat as disabled
			} finally {
				if (!cancelled) setIsLoading(false);
			}
		})();

		return () => { cancelled = true; };
	}, []);

	// Listen for 401 events from API client
	useEffect(() => {
		const handleUnauthorized = () => {
			setUser(null);
		};
		window.addEventListener("auth:unauthorized", handleUnauthorized);
		return () => window.removeEventListener("auth:unauthorized", handleUnauthorized);
	}, []);

	const login = useCallback(async (credential: string) => {
		setError(null);
		try {
			const result = await apiClient.loginWithGoogle(credential);
			setUser(result.user);
		} catch (err: unknown) {
			const message = err instanceof Error ? err.message : "Login failed";
			setError(message);
			throw err;
		}
	}, []);

	const logout = useCallback(() => {
		apiClient.logout();
		setUser(null);
	}, []);

	return (
		<AuthContext.Provider
			value={{ user, isLoading, isAuthEnabled, login, logout, error, clearError }}
		>
			{children}
		</AuthContext.Provider>
	);
}

export function useAuth(): AuthContextType {
	const context = useContext(AuthContext);
	if (!context) {
		throw new Error("useAuth must be used within AuthProvider");
	}
	return context;
}
```

**Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/web/contexts/AuthContext.tsx
git commit -m "Add AuthContext provider with Google login and token management"
```

---

## Task 9: LoginPage Component

Create the login page with Google Sign-In button.

**Files:**
- Create: `src/web/components/LoginPage.tsx`

**Step 1: Write the component**

```tsx
// src/web/components/LoginPage.tsx
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useAuth } from "../contexts/AuthContext";

interface GoogleCredentialResponse {
	credential: string;
}

declare global {
	interface Window {
		google?: {
			accounts: {
				id: {
					initialize: (config: {
						client_id: string;
						callback: (response: GoogleCredentialResponse) => void;
					}) => void;
					renderButton: (
						element: HTMLElement,
						config: { theme: string; size: string; width: number },
					) => void;
				};
			};
		};
	}
}

export default function LoginPage({ clientId }: { clientId: string }) {
	const { login, error, clearError } = useAuth();
	const buttonRef = useRef<HTMLDivElement>(null);
	const [sdkLoaded, setSdkLoaded] = useState(false);
	const [isLoggingIn, setIsLoggingIn] = useState(false);

	// Load Google Sign-In SDK
	useEffect(() => {
		if (document.getElementById("google-signin-sdk")) {
			if (window.google) setSdkLoaded(true);
			return;
		}

		const script = document.createElement("script");
		script.id = "google-signin-sdk";
		script.src = "https://accounts.google.com/gsi/client";
		script.async = true;
		script.onload = () => setSdkLoaded(true);
		document.head.appendChild(script);
	}, []);

	const handleCredential = useCallback(
		async (response: GoogleCredentialResponse) => {
			setIsLoggingIn(true);
			clearError();
			try {
				await login(response.credential);
			} catch {
				// Error is handled by AuthContext
			} finally {
				setIsLoggingIn(false);
			}
		},
		[login, clearError],
	);

	// Initialize Google button once SDK is loaded
	useEffect(() => {
		if (!sdkLoaded || !window.google || !buttonRef.current) return;

		window.google.accounts.id.initialize({
			client_id: clientId,
			callback: handleCredential,
		});

		window.google.accounts.id.renderButton(buttonRef.current, {
			theme: "outline",
			size: "large",
			width: 300,
		});
	}, [sdkLoaded, clientId, handleCredential]);

	return (
		<div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
			<div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-700 dark:bg-gray-800">
				<div className="mb-8 text-center">
					<h1 className="text-2xl font-bold text-gray-900 dark:text-white">
						Backlog.md
					</h1>
					<p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
						Sign in to continue
					</p>
				</div>

				{error && (
					<div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-900/20 dark:text-red-400">
						{error}
					</div>
				)}

				{isLoggingIn ? (
					<div className="flex justify-center">
						<div className="text-sm text-gray-500 dark:text-gray-400">
							Signing in...
						</div>
					</div>
				) : (
					<div className="flex justify-center">
						<div ref={buttonRef} />
					</div>
				)}

				{!sdkLoaded && !isLoggingIn && (
					<div className="flex justify-center">
						<div className="text-sm text-gray-400">Loading...</div>
					</div>
				)}
			</div>
		</div>
	);
}
```

**Step 2: Run type check**

Run: `bunx tsc --noEmit`
Expected: No type errors

**Step 3: Commit**

```bash
git add src/web/components/LoginPage.tsx
git commit -m "Add LoginPage component with Google Sign-In button"
```

---

## Task 10: Wire Auth Into the App

Wrap the app with AuthProvider and add route protection.

**Files:**
- Modify: `src/web/main.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/components/Layout.tsx` (add user info and logout button)

**Step 1: Wrap app with AuthProvider in `main.tsx`**

```tsx
// src/web/main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { HealthCheckProvider } from './contexts/HealthCheckContext';
import { AuthProvider } from './contexts/AuthContext';

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(
  <React.StrictMode>
    <HealthCheckProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </HealthCheckProvider>
  </React.StrictMode>
);
```

**Step 2: Add auth gate in `App.tsx`**

At the top of the `App` component function (inside `ThemeProvider` and `BrowserRouter`), add:

```tsx
import { useAuth } from './contexts/AuthContext';
import LoginPage from './components/LoginPage';

// Inside the App component, before the existing return:
const { user, isLoading: authLoading, isAuthEnabled } = useAuth();

// Show login page if auth is enabled but user is not authenticated
if (authLoading) {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-gray-500">Loading...</div>
    </div>
  );
}

if (isAuthEnabled && !user) {
  // Fetch clientId from the auth status (already cached in context)
  return <LoginPage clientId={/* read from auth status */} />;
}
```

> The exact integration will depend on reading the AuthContext more carefully. The `clientId` needs to be exposed from `AuthContext` or fetched once.

**Step 3: Add user info + logout to Layout.tsx**

In the top navigation area of `Layout.tsx`, add a small user badge and logout button (only when `isAuthEnabled`):

```tsx
const { user, isAuthEnabled, logout } = useAuth();

// In the header/nav area:
{isAuthEnabled && user && (
  <div className="flex items-center gap-2">
    <span className="text-sm text-gray-600 dark:text-gray-400">
      {user.name}
      {user.role === "viewer" && (
        <span className="ml-1 text-xs text-gray-400">(viewer)</span>
      )}
    </span>
    <button
      onClick={logout}
      className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
    >
      Sign out
    </button>
  </div>
)}
```

**Step 4: Hide write actions for viewers**

Pass `user.role` down or use `useAuth()` in components that have create/edit/delete buttons. When `role === "viewer"`, hide those buttons. Key components to modify:
- `TaskList.tsx` — hide "Create Task" button
- `Board.tsx` / `BoardPage.tsx` — hide drag-and-drop, create task
- `DocumentationDetail.tsx` — hide create/edit
- `DecisionDetail.tsx` — hide create/edit
- `MilestonesPage.tsx` — hide create/archive
- `Settings.tsx` — hide save button

For each, wrap the action elements in a conditional:

```tsx
const { user } = useAuth();
const isViewer = user?.role === "viewer";

// Then wrap action buttons:
{!isViewer && <button>Create Task</button>}
```

**Step 5: Run type check + test suite**

Run: `bunx tsc --noEmit && CLAUDECODE=1 bun test --timeout 180000`
Expected: No errors

**Step 6: Commit**

```bash
git add src/web/main.tsx src/web/App.tsx src/web/components/Layout.tsx src/web/contexts/AuthContext.tsx src/web/components/LoginPage.tsx src/web/components/TaskList.tsx src/web/components/Board.tsx src/web/components/BoardPage.tsx src/web/components/DocumentationDetail.tsx src/web/components/DecisionDetail.tsx src/web/components/MilestonesPage.tsx src/web/components/Settings.tsx
git commit -m "Wire auth into app with route protection and viewer restrictions"
```

---

## Task 11: Build CSS and Manual Smoke Test

Rebuild Tailwind CSS (LoginPage uses new classes) and verify the full flow manually.

**Step 1: Rebuild CSS**

Run: `bun run build:css`

**Step 2: Manual smoke test (no env vars — auth disabled)**

Run: `bun src/cli.ts browser`

- Verify the app loads without any login screen
- Verify all features work as before (create task, edit, etc.)
- Check console for "Authentication disabled" log message

**Step 3: Manual smoke test (with env vars — auth enabled)**

Set up environment variables and run:

```bash
GOOGLE_CLIENT_ID=your-client-id AUTH_CONFIG_REPO=/path/to/config/repo bun src/cli.ts browser
```

- Verify login page appears
- Verify Google Sign-In button renders
- Test login flow with a whitelisted Google account
- Verify viewer role cannot create/edit
- Verify admin role has full access
- Verify logout works

**Step 4: Run full test suite one final time**

Run: `bunx tsc --noEmit && bun run check . && CLAUDECODE=1 bun test --timeout 180000`
Expected: All pass

**Step 5: Commit CSS if changed**

```bash
git add src/web/styles/style.css
git commit -m "Rebuild CSS with login page styles"
```

---

## Summary

| Task | Description | New Files | Modified Files |
|------|-------------|-----------|----------------|
| 1 | JWT utility | `src/server/auth/jwt.ts`, test | — |
| 2 | Users store | `src/server/auth/users-store.ts`, test | — |
| 3 | Config repo service | `src/server/auth/config-repo.ts`, test | — |
| 4 | Google token verification | `src/server/auth/google-verify.ts`, test | — |
| 5 | Auth middleware | `src/server/auth/middleware.ts`, test | — |
| 6 | Wire into server | `src/server/auth/index.ts` | `src/server/index.ts` |
| 7 | API client auth | — | `src/web/lib/api.ts` |
| 8 | AuthContext | `src/web/contexts/AuthContext.tsx` | — |
| 9 | LoginPage | `src/web/components/LoginPage.tsx` | — |
| 10 | Wire into app | — | `main.tsx`, `App.tsx`, `Layout.tsx`, ~6 components |
| 11 | Build + smoke test | — | `style.css` |
