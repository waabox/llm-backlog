/**
 * Minimal JWT sign/verify utility using HMAC-SHA256 via Bun's native crypto.
 *
 * No external dependencies -- relies on Bun.CryptoHasher for synchronous HMAC
 * and btoa/atob for base64 encoding.
 */

import { timingSafeEqual } from "node:crypto";

export interface JwtPayload {
	email: string;
	name: string;
	role: string;
	iat: number;
	exp: number;
}

const JWT_HEADER = JSON.stringify({ alg: "HS256", typ: "JWT" });

function base64UrlEncode(data: string): string {
	return btoa(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(encoded: string): string {
	// Restore standard base64 characters and padding
	let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const paddingNeeded = (4 - (base64.length % 4)) % 4;
	base64 += "=".repeat(paddingNeeded);
	return atob(base64);
}

function hmacSign(message: string, secret: string): string {
	const hasher = new Bun.CryptoHasher("sha256", secret);
	hasher.update(message);
	const digest = hasher.digest();
	// Convert the Uint8Array digest to a base64url string
	const binaryString = Array.from(digest, (byte) => String.fromCharCode(byte)).join("");
	return btoa(binaryString).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Creates a signed JWT token with HS256.
 *
 * @param payload - The claims to include (email, name, role)
 * @param secret - The HMAC secret key
 * @param expiresInSeconds - Token lifetime in seconds from now
 * @returns A signed JWT string (header.payload.signature)
 */
export function signJwt(
	payload: { email: string; name: string; role: string },
	secret: string,
	expiresInSeconds: number,
): string {
	const now = Math.floor(Date.now() / 1000);
	const fullPayload: JwtPayload = {
		email: payload.email,
		name: payload.name,
		role: payload.role,
		iat: now,
		exp: now + expiresInSeconds,
	};

	const encodedHeader = base64UrlEncode(JWT_HEADER);
	const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const signature = hmacSign(signingInput, secret);

	return `${signingInput}.${signature}`;
}

/**
 * Verifies a JWT token's signature and expiration.
 *
 * @param token - The JWT string to verify
 * @param secret - The HMAC secret key used to sign the token
 * @returns The decoded payload if valid, or null if invalid/expired
 */
export function verifyJwt(token: string, secret: string): JwtPayload | null {
	const parts = token.split(".");
	if (parts.length !== 3) {
		return null;
	}

	const [encodedHeader, encodedPayload, signature] = parts as [string, string, string];
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	const expectedSignature = hmacSign(signingInput, secret);

	const sigBytes = Buffer.from(signature);
	const expectedBytes = Buffer.from(expectedSignature);
	if (sigBytes.length !== expectedBytes.length) {
		return null;
	}
	if (!timingSafeEqual(sigBytes, expectedBytes)) {
		return null;
	}

	try {
		const payload = JSON.parse(base64UrlDecode(encodedPayload)) as JwtPayload;
		const now = Math.floor(Date.now() / 1000);

		if (typeof payload.exp !== "number" || payload.exp <= now) {
			return null;
		}

		return payload;
	} catch {
		return null;
	}
}
