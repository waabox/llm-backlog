/**
 * Google id_token verification via the Google tokeninfo endpoint.
 *
 * Validates that a Google-issued id_token is authentic, addressed to our
 * application (audience check), and contains a verified email address.
 */

interface GoogleTokenPayload {
	email: string;
	name: string;
	picture?: string;
	email_verified: boolean | string;
	aud: string;
	sub: string;
}

/**
 * Verifies a Google id_token against the Google tokeninfo endpoint.
 *
 * Checks that the token is valid, the audience matches our client ID,
 * and the email is present and verified.
 *
 * @param idToken - The id_token string received from Google OAuth
 * @param clientId - The Google OAuth client ID to verify the audience against
 * @returns The user's email and name if valid, or null if verification fails
 */
export async function verifyGoogleToken(
	idToken: string,
	clientId: string,
): Promise<{ email: string; name: string } | null> {
	try {
		if (!idToken) {
			return null;
		}

		const response = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);

		if (!response.ok) {
			return null;
		}

		const payload = (await response.json()) as GoogleTokenPayload;

		if (payload.aud !== clientId) {
			return null;
		}

		// Google may return email_verified as a string "true" or a boolean
		const emailVerified = payload.email_verified === true || payload.email_verified === "true";

		if (!payload.email || !emailVerified) {
			return null;
		}

		return {
			email: payload.email,
			name: payload.name || payload.email,
		};
	} catch {
		return null;
	}
}
