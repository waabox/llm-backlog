import { describe, expect, it } from "bun:test";
import { signJwt, verifyJwt } from "./jwt.ts";

const TEST_SECRET = "test-secret-key-for-jwt-unit-tests";

describe("JWT sign/verify", () => {
	it("signJwt returns a string with three dot-separated parts", () => {
		const token = signJwt({ email: "user@example.com", name: "Test User", role: "admin" }, TEST_SECRET, 3600);

		expect(typeof token).toBe("string");
		const parts = token.split(".");
		expect(parts.length).toBe(3);
		for (const part of parts) {
			expect(part.length).toBeGreaterThan(0);
		}
	});

	it("verifyJwt returns the payload for a valid token", () => {
		const token = signJwt({ email: "alice@test.com", name: "Alice", role: "editor" }, TEST_SECRET, 3600);
		const payload = verifyJwt(token, TEST_SECRET);

		expect(payload).not.toBeNull();
		expect(payload?.email).toBe("alice@test.com");
		expect(payload?.name).toBe("Alice");
		expect(payload?.role).toBe("editor");
		expect(typeof payload?.iat).toBe("number");
		expect(typeof payload?.exp).toBe("number");
		expect(payload?.exp).toBeGreaterThan(payload?.iat ?? 0);
	});

	it("verifyJwt returns null for an expired token", () => {
		const token = signJwt({ email: "expired@test.com", name: "Expired", role: "viewer" }, TEST_SECRET, -1);
		const payload = verifyJwt(token, TEST_SECRET);

		expect(payload).toBeNull();
	});

	it("verifyJwt returns null for a token signed with a different secret", () => {
		const token = signJwt({ email: "user@test.com", name: "User", role: "admin" }, "secret-one", 3600);
		const payload = verifyJwt(token, "secret-two");

		expect(payload).toBeNull();
	});

	it("verifyJwt returns null for malformed tokens", () => {
		expect(verifyJwt("", TEST_SECRET)).toBeNull();
		expect(verifyJwt("not.a.jwt", TEST_SECRET)).toBeNull();
		expect(verifyJwt("only-one-part", TEST_SECRET)).toBeNull();
		expect(verifyJwt("two.parts", TEST_SECRET)).toBeNull();
	});
});
