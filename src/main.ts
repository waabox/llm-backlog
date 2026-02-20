import { Core } from "./core/backlog.ts";
import { BacklogServer } from "./server/index.ts";

const remoteRepo = process.env.BACKLOG_PROJECT_REPO ?? null;
const cwd = process.cwd();
const server = new BacklogServer(cwd);

let defaultPort = 6420;
if (!remoteRepo) {
	const core = new Core(cwd);
	const config = await core.filesystem.loadConfig();
	defaultPort = config?.defaultPort ?? 6420;
}

const port = Number.parseInt(process.env.PORT ?? String(defaultPort), 10);
const openBrowser = process.env.OPEN_BROWSER !== "false";

await server.start(port, openBrowser);

let shuttingDown = false;
const shutdown = async (signal: string) => {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`\nReceived ${signal}. Shutting down...`);
	try {
		await Promise.race([server.stop(), new Promise<void>((r) => setTimeout(r, 1500))]);
	} finally {
		process.exit(0);
	}
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGQUIT", () => void shutdown("SIGQUIT"));
