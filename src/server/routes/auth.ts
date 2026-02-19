import type { ConfigRepoService } from "../auth/config-repo";
import { verifyGoogleToken } from "../auth/google-verify";
import { signJwt, verifyJwt } from "../auth/jwt";
import { extractBearerToken } from "../auth/middleware";

export async function handleGoogleLogin(
	req: Request,
	authEnabled: boolean,
	googleClientId: string | null,
	configRepoService: ConfigRepoService | null,
	jwtSecret: string,
): Promise<Response> {
	if (!authEnabled || !googleClientId || !configRepoService) {
		return Response.json({ error: "Authentication is not enabled" }, { status: 400 });
	}

	let body: { credential?: string };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid request body" }, { status: 400 });
	}

	const credential = body?.credential;
	if (typeof credential !== "string" || !credential) {
		return Response.json({ error: "Missing credential" }, { status: 400 });
	}

	const googleUser = await verifyGoogleToken(credential, googleClientId);
	if (!googleUser) {
		return Response.json({ error: "Invalid Google token" }, { status: 401 });
	}

	const user = configRepoService.findUserByEmail(googleUser.email);
	if (!user) {
		return Response.json({ error: "Your account does not have access" }, { status: 403 });
	}

	const token = signJwt(
		{ email: user.email, name: user.name, role: user.role },
		jwtSecret,
		24 * 60 * 60, // 24 hours
	);

	return Response.json({ token, user: { email: user.email, name: user.name, role: user.role } });
}

export async function handleGetMe(req: Request, jwtSecret: string): Promise<Response> {
	const token = extractBearerToken(req.headers.get("authorization"));
	if (!token) {
		return Response.json({ error: "Not authenticated" }, { status: 401 });
	}

	const payload = verifyJwt(token, jwtSecret);
	if (!payload) {
		return Response.json({ error: "Invalid token" }, { status: 401 });
	}

	return Response.json({ email: payload.email, name: payload.name, role: payload.role });
}
