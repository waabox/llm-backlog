/**
 * Authentication middleware helpers for the llm-backlog HTTP server.
 *
 * Provides request-level auth checks: bearer-token extraction, route
 * classification (public vs protected), write-method detection, and a
 * single `authenticateRequest` entry-point that composes all of the above.
 */

import { type JwtPayload, verifyJwt } from "./jwt";

const PUBLIC_ROUTES = new Set(["/api/auth/status", "/api/auth/google"]);

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE"]);

/**
 * Extracts a bearer token from an Authorization header value.
 *
 * @param headerValue - The raw Authorization header, or null if absent.
 * @returns The token string when the header uses the "Bearer" scheme, null otherwise.
 */
export function extractBearerToken(headerValue: string | null): string | null {
	if (headerValue === null || !headerValue.startsWith("Bearer ")) {
		return null;
	}
	return headerValue.slice("Bearer ".length);
}

/**
 * Determines whether a route is publicly accessible (no auth required).
 *
 * A route is public when it is either explicitly listed in PUBLIC_ROUTES or
 * when it falls outside the /api/ namespace entirely.
 *
 * @param pathname - The URL pathname to classify.
 * @returns True if the route does not require authentication.
 */
export function isPublicRoute(pathname: string): boolean {
	return PUBLIC_ROUTES.has(pathname) || !pathname.startsWith("/api/");
}

/**
 * Returns true when the HTTP method implies a state-changing (write) operation.
 *
 * @param method - The HTTP method in upper-case (e.g. "POST").
 * @returns True for POST, PUT, and DELETE.
 */
export function isWriteMethod(method: string): boolean {
	return WRITE_METHODS.has(method.toUpperCase());
}

/**
 * Authenticates an incoming request against the JWT-based auth layer.
 *
 * When auth is disabled or the route is public the function short-circuits,
 * returning a null payload and no error. For protected routes it validates
 * the bearer token, checks the JWT signature/expiry, and enforces role-based
 * write restrictions (viewers may not issue mutating requests).
 *
 * @param req - The incoming Request object.
 * @param authEnabled - Feature flag controlling whether auth is enforced.
 * @param jwtSecret - The HMAC secret used to verify JWT signatures.
 * @returns An object with the decoded payload (if authenticated) and an
 *          optional error Response that the caller should return immediately.
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

	const token = extractBearerToken(req.headers.get("Authorization"));

	if (token === null) {
		return {
			payload: null,
			errorResponse: new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		};
	}

	const payload = verifyJwt(token, jwtSecret);

	if (payload === null) {
		return {
			payload: null,
			errorResponse: new Response(JSON.stringify({ error: "Unauthorized" }), {
				status: 401,
				headers: { "Content-Type": "application/json" },
			}),
		};
	}

	if (payload.role === "viewer" && isWriteMethod(req.method)) {
		return {
			payload,
			errorResponse: new Response(JSON.stringify({ error: "Forbidden" }), {
				status: 403,
				headers: { "Content-Type": "application/json" },
			}),
		};
	}

	return { payload, errorResponse: null };
}
