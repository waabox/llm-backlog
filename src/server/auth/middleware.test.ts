import { describe, expect, it } from "bun:test";
import { signJwt } from "./jwt.ts";
import { authenticateRequest, extractBearerToken, isPublicRoute, isWriteMethod } from "./middleware.ts";

const TEST_SECRET = "test-secret-key-for-middleware-tests";

describe("extractBearerToken", () => {
	it("extracts the token from a valid Bearer header", () => {
		expect(extractBearerToken("Bearer abc123")).toBe("abc123");
	});

	it("returns null for a null header", () => {
		expect(extractBearerToken(null)).toBeNull();
	});

	it("returns null for a non-Bearer scheme", () => {
		expect(extractBearerToken("Basic abc123")).toBeNull();
	});
});

describe("isPublicRoute", () => {
	it("treats /api/auth/status and /api/auth/google as public", () => {
		expect(isPublicRoute("/api/auth/status")).toBe(true);
		expect(isPublicRoute("/api/auth/google")).toBe(true);
	});

	it("treats /api/tasks and /api/config as protected", () => {
		expect(isPublicRoute("/api/tasks")).toBe(false);
		expect(isPublicRoute("/api/config")).toBe(false);
	});

	it("treats non-API routes as public", () => {
		expect(isPublicRoute("/")).toBe(true);
		expect(isPublicRoute("/tasks")).toBe(true);
	});
});

describe("isWriteMethod", () => {
	it("considers POST, PUT, and DELETE as write methods", () => {
		expect(isWriteMethod("POST")).toBe(true);
		expect(isWriteMethod("PUT")).toBe(true);
		expect(isWriteMethod("DELETE")).toBe(true);
	});

	it("does not consider GET or HEAD as write methods", () => {
		expect(isWriteMethod("GET")).toBe(false);
		expect(isWriteMethod("HEAD")).toBe(false);
	});
});

describe("authenticateRequest", () => {
	it("skips auth when authEnabled is false", () => {
		const req = new Request("http://localhost/api/tasks", { method: "GET" });
		const result = authenticateRequest(req, false, TEST_SECRET);

		expect(result.payload).toBeNull();
		expect(result.errorResponse).toBeNull();
	});

	it("skips auth for public routes even when authEnabled is true", () => {
		const req = new Request("http://localhost/api/auth/status", { method: "GET" });
		const result = authenticateRequest(req, true, TEST_SECRET);

		expect(result.payload).toBeNull();
		expect(result.errorResponse).toBeNull();
	});

	it("returns 401 when no Authorization header is present", async () => {
		const req = new Request("http://localhost/api/tasks", { method: "GET" });
		const result = authenticateRequest(req, true, TEST_SECRET);

		expect(result.payload).toBeNull();
		expect(result.errorResponse).not.toBeNull();
		expect(result.errorResponse?.status).toBe(401);

		const body = (await result.errorResponse?.json()) as { error: string };
		expect(body.error).toBe("Unauthorized");
	});

	it("returns 401 for an invalid JWT token", async () => {
		const req = new Request("http://localhost/api/tasks", {
			method: "GET",
			headers: { Authorization: "Bearer invalid.token.here" },
		});
		const result = authenticateRequest(req, true, TEST_SECRET);

		expect(result.payload).toBeNull();
		expect(result.errorResponse).not.toBeNull();
		expect(result.errorResponse?.status).toBe(401);
	});

	it("returns the payload for a valid token on a GET request", () => {
		const token = signJwt({ email: "user@test.com", name: "User", role: "admin" }, TEST_SECRET, 3600);
		const req = new Request("http://localhost/api/tasks", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		const result = authenticateRequest(req, true, TEST_SECRET);

		expect(result.errorResponse).toBeNull();
		expect(result.payload).not.toBeNull();
		expect(result.payload?.email).toBe("user@test.com");
		expect(result.payload?.role).toBe("admin");
	});

	it("returns 403 when a viewer attempts a write method", async () => {
		const token = signJwt({ email: "viewer@test.com", name: "Viewer", role: "viewer" }, TEST_SECRET, 3600);
		const req = new Request("http://localhost/api/tasks", {
			method: "POST",
			headers: { Authorization: `Bearer ${token}` },
		});
		const result = authenticateRequest(req, true, TEST_SECRET);

		expect(result.payload).not.toBeNull();
		expect(result.errorResponse).not.toBeNull();
		expect(result.errorResponse?.status).toBe(403);

		const body = (await result.errorResponse?.json()) as { error: string };
		expect(body.error).toBe("Forbidden");
	});

	it("allows a viewer to perform a GET request", () => {
		const token = signJwt({ email: "viewer@test.com", name: "Viewer", role: "viewer" }, TEST_SECRET, 3600);
		const req = new Request("http://localhost/api/tasks", {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
		});
		const result = authenticateRequest(req, true, TEST_SECRET);

		expect(result.errorResponse).toBeNull();
		expect(result.payload).not.toBeNull();
		expect(result.payload?.role).toBe("viewer");
	});
});
