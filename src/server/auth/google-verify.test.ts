import { describe, expect, it } from "bun:test";
import { verifyGoogleToken } from "./google-verify.ts";

const FAKE_CLIENT_ID = "test-client-id.apps.googleusercontent.com";

describe("verifyGoogleToken", () => {
	it("returns null for a completely invalid token", async () => {
		const result = await verifyGoogleToken("not-a-real-token", FAKE_CLIENT_ID);
		expect(result).toBeNull();
	});

	it("returns null for an empty string", async () => {
		const result = await verifyGoogleToken("", FAKE_CLIENT_ID);
		expect(result).toBeNull();
	});
});
