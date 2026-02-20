import { dirname, join } from "node:path";
import type { Server, ServerWebSocket } from "bun";
import { $ } from "bun";
import { Core } from "../core/backlog.ts";
import type { ContentStore } from "../core/content-store.ts";
import { createMcpRequestHandler, type McpRequestHandler } from "../mcp/http-transport.ts";
import { watchConfig } from "../utils/config-watcher.ts";
// @ts-expect-error
import favicon from "../web/favicon.png" with { type: "file" };
import indexHtml from "../web/index.html";
import { ConfigRepoService } from "./auth/config-repo";
import { authenticateRequest } from "./auth/middleware";
import { ProjectRepoService } from "./project-repo";
import { handleDeleteAsset, handleListAssets, handleUploadAsset } from "./routes/assets.ts";
import { handleGetMe, handleGoogleLogin } from "./routes/auth.ts";
import {
	handleGetConfig,
	handleUpdateConfig,
	handleGetStatistics,
	handleGetStatus,
	handleGetStatuses,
	handleGetVersion,
} from "./routes/config.ts";
import {
	handleCreateDecision,
	handleGetDecision,
	handleListDecisions,
	handleUpdateDecision,
} from "./routes/decisions.ts";
import { handleCreateDoc, handleGetDoc, handleListDocs, handleUpdateDoc } from "./routes/documents.ts";
import { handleListDrafts, handlePromoteDraft } from "./routes/drafts.ts";
import { handleInit } from "./routes/init.ts";
import {
	handleArchiveMilestone,
	handleCreateMilestone,
	handleGetMilestone,
	handleListArchivedMilestones,
	handleListMilestones,
} from "./routes/milestones.ts";
import { handleGetSequences, handleMoveSequence } from "./routes/sequences.ts";
import {
	handleCleanupExecute,
	handleCleanupPreview,
	handleCompleteTask,
	handleCreateTask,
	handleDeleteTask,
	handleGetTask,
	handleListTasks,
	handleReorderTask,
	handleSearch,
	handleUpdateTask,
} from "./routes/tasks.ts";

export class BacklogServer {
	private core: Core;
	private server: Server<unknown> | null = null;
	private projectName = "Untitled Project";
	private sockets = new Set<ServerWebSocket<unknown>>();
	private contentStore: ContentStore | null = null;
	private unsubscribeContentStore?: () => void;
	private storeReadyBroadcasted = false;
	private configWatcher: { stop: () => void } | null = null;
	private configRepoService: ConfigRepoService | null = null;
	private projectRepoService: ProjectRepoService | null = null;
	private authEnabled = false;
	private jwtSecret: string = crypto.randomUUID();
	private googleClientId: string | null = null;
	private mcpHandler: McpRequestHandler | null = null;
	private readonly projectRepoUrl: string | null;

	constructor(projectPath: string) {
		this.projectRepoUrl = process.env.BACKLOG_PROJECT_REPO ?? null;
		if (!this.projectRepoUrl) {
			this.core = new Core(projectPath, { enableWatchers: true });
		} else {
			// Core will be initialized in start() after the repo is cloned
			this.core = null as unknown as Core;
		}
	}

	/**
	 * Wraps a route handler with authentication enforcement.
	 *
	 * The returned handler runs authenticateRequest before delegating to the
	 * original handler. If authentication fails, an error Response is returned
	 * immediately without ever invoking the inner handler.
	 *
	 * @param handler - The route handler to protect.
	 * @returns A new handler that checks auth first.
	 */
	private protect<T extends Request>(handler: (req: T) => Promise<Response>): (req: T) => Promise<Response> {
		return async (req: T) => {
			const { errorResponse } = authenticateRequest(req, this.authEnabled, this.jwtSecret);
			if (errorResponse) return errorResponse;
			return handler.call(this, req);
		};
	}

	private async ensureServicesReady(): Promise<void> {
		const store = await this.core.getContentStore();
		this.contentStore = store;

		if (!this.unsubscribeContentStore) {
			this.unsubscribeContentStore = store.subscribe((event) => {
				if (event.type === "ready") {
					if (!this.storeReadyBroadcasted) {
						this.storeReadyBroadcasted = true;
						return;
					}
					this.broadcastTasksUpdated();
					return;
				}

				// Broadcast for tasks/documents/decisions so clients refresh caches/search
				this.storeReadyBroadcasted = true;
				this.broadcastTasksUpdated();
			});
		}

		await this.core.getSearchService();
	}

	getPort(): number | null {
		return this.server?.port ?? null;
	}

	private broadcastTasksUpdated() {
		for (const ws of this.sockets) {
			try {
				ws.send("tasks-updated");
			} catch {}
		}
	}

	private broadcastConfigUpdated() {
		for (const ws of this.sockets) {
			try {
				ws.send("config-updated");
			} catch {}
		}
	}

	async start(port?: number, openBrowser = true): Promise<void> {
		// Prevent duplicate starts (e.g., accidental re-entry)
		if (this.server) {
			console.log("Server already running");
			return;
		}

		// Clone remote project repo if BACKLOG_PROJECT_REPO is set
		if (this.projectRepoUrl) {
			console.log(`Cloning project repo: ${this.projectRepoUrl}`);
			this.projectRepoService = new ProjectRepoService(this.projectRepoUrl);
			await this.projectRepoService.start();
			this.core = new Core(this.projectRepoService.dir, { enableWatchers: true });
			this.core.git.setAutoPush(true);
			this.core.setAutoCommitOverride(true);
		}

		// Load config (migration is handled globally by CLI)
		const config = await this.core.filesystem.loadConfig();

		// Use config default port if no port specified
		const finalPort = port ?? config?.defaultPort ?? 6420;
		this.projectName = config?.projectName || "Untitled Project";

		// Check if browser should open (config setting or CLI override)
		// Default to true if autoOpenBrowser is not explicitly set to false
		const shouldOpenBrowser = openBrowser && (config?.autoOpenBrowser ?? true);

		// Set up config watcher to broadcast changes
		this.configWatcher = watchConfig(this.core, {
			onConfigChanged: () => {
				this.broadcastConfigUpdated();
			},
		});

		// Initialize auth if environment variables are configured
		this.googleClientId = process.env.GOOGLE_CLIENT_ID ?? null;
		const authConfigRepo = process.env.AUTH_CONFIG_REPO ?? null;
		this.jwtSecret = process.env.JWT_SECRET ?? crypto.randomUUID();

		// Start ConfigRepoService when AUTH_CONFIG_REPO is set — needed for
		// both Google OAuth (web UI) and API key auth (MCP endpoint).
		if (authConfigRepo) {
			this.configRepoService = new ConfigRepoService(authConfigRepo);
			await this.configRepoService.start();
		}

		if (this.googleClientId && this.configRepoService) {
			this.authEnabled = true;
			console.log("Auth enabled (Google OAuth + MCP API key)");
		} else if (this.configRepoService) {
			console.log("MCP API key auth enabled (set GOOGLE_CLIENT_ID for web auth)");
		} else {
			console.log("Auth disabled (set AUTH_CONFIG_REPO to enable)");
		}

		try {
			await this.ensureServicesReady();

			// Mount MCP endpoint — uses API key auth when ConfigRepoService is available
			const mcpAuthEnabled = !!this.configRepoService;
			this.mcpHandler = await createMcpRequestHandler({
				projectRoot: this.core.filesystem.rootDir,
				authEnabled: mcpAuthEnabled,
				findUserByApiKey: mcpAuthEnabled
					? (key: string) => this.configRepoService?.findUserByApiKey(key) ?? null
					: undefined,
			});

			const serveOptions = {
				port: finalPort,
				development: process.env.NODE_ENV === "development",
				routes: {
					"/": indexHtml,
					"/tasks": indexHtml,
					"/tasks/*": indexHtml,
					"/milestones": indexHtml,
					"/milestones/*": indexHtml,
					"/drafts": indexHtml,
					"/documentation": indexHtml,
					"/documentation/*": indexHtml,
					"/decisions": indexHtml,
					"/decisions/*": indexHtml,
					"/statistics": indexHtml,
					"/settings": indexHtml,

					// API Routes using Bun's native route syntax
					"/api/tasks": {
						GET: this.protect(async (req: Request) => await handleListTasks(req, this.core)),
						POST: this.protect(
							async (req: Request) => await handleCreateTask(req, this.core, () => this.broadcastTasksUpdated()),
						),
					},
					"/api/task/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetTask(req.params.id, this.core),
						),
					},
					"/api/tasks/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetTask(req.params.id, this.core),
						),
						PUT: this.protect(
							async (req: Request & { params: { id: string } }) =>
								await handleUpdateTask(req, req.params.id, this.core, () => this.broadcastTasksUpdated()),
						),
						DELETE: this.protect(
							async (req: Request & { params: { id: string } }) => await handleDeleteTask(req.params.id, this.core),
						),
					},
					"/api/tasks/:id/complete": {
						POST: this.protect(
							async (req: Request & { params: { id: string } }) =>
								await handleCompleteTask(req.params.id, this.core, () => this.broadcastTasksUpdated()),
						),
					},
					"/api/tasks/:id/assets": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleListAssets(req.params.id, this.core),
						),
						POST: this.protect(
							async (req: Request & { params: { id: string } }) =>
								await handleUploadAsset(req, req.params.id, this.core),
						),
					},
					"/api/tasks/:id/assets/:filename": {
						DELETE: this.protect(
							async (req: Request & { params: { id: string; filename: string } }) =>
								await handleDeleteAsset(req.params.id, decodeURIComponent(req.params.filename), this.core),
						),
					},
					"/api/statuses": {
						GET: this.protect(async () => await handleGetStatuses(this.core)),
					},
					"/api/config": {
						GET: this.protect(async () => await handleGetConfig(this.core)),
						PUT: this.protect(async (req: Request) => {
							const res = await handleUpdateConfig(this.core, req);
							if (res.ok) this.broadcastConfigUpdated();
							return res;
						}),
					},
					"/api/docs": {
						GET: this.protect(async () => await handleListDocs(this.core)),
						POST: this.protect(async (req: Request) => await handleCreateDoc(req, this.core)),
					},
					"/api/doc/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetDoc(req.params.id, this.core),
						),
					},
					"/api/docs/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetDoc(req.params.id, this.core),
						),
						PUT: this.protect(
							async (req: Request & { params: { id: string } }) => await handleUpdateDoc(req, req.params.id, this.core),
						),
					},
					"/api/decisions": {
						GET: this.protect(async () => await handleListDecisions(this.core)),
						POST: this.protect(async (req: Request) => await handleCreateDecision(req, this.core)),
					},
					"/api/decision/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetDecision(req.params.id, this.core),
						),
					},
					"/api/decisions/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetDecision(req.params.id, this.core),
						),
						PUT: this.protect(
							async (req: Request & { params: { id: string } }) =>
								await handleUpdateDecision(req, req.params.id, this.core),
						),
					},
					"/api/drafts": {
						GET: this.protect(async () => await handleListDrafts(this.core)),
					},
					"/api/drafts/:id/promote": {
						POST: this.protect(
							async (req: Request & { params: { id: string } }) => await handlePromoteDraft(req.params.id, this.core),
						),
					},
					"/api/milestones": {
						GET: this.protect(async () => await handleListMilestones(this.core)),
						POST: this.protect(async (req: Request) => await handleCreateMilestone(req, this.core)),
					},
					"/api/milestones/archived": {
						GET: this.protect(async () => await handleListArchivedMilestones(this.core)),
					},
					"/api/milestones/:id": {
						GET: this.protect(
							async (req: Request & { params: { id: string } }) => await handleGetMilestone(req.params.id, this.core),
						),
					},
					"/api/milestones/:id/archive": {
						POST: this.protect(
							async (req: Request & { params: { id: string } }) =>
								await handleArchiveMilestone(req.params.id, this.core, () => this.broadcastTasksUpdated()),
						),
					},
					"/api/tasks/reorder": {
						POST: this.protect(async (req: Request) => await handleReorderTask(req, this.core)),
					},
					"/api/tasks/cleanup": {
						GET: this.protect(async (req: Request) => await handleCleanupPreview(req, this.core)),
					},
					"/api/tasks/cleanup/execute": {
						POST: this.protect(
							async (req: Request) => await handleCleanupExecute(req, this.core, () => this.broadcastTasksUpdated()),
						),
					},
					"/api/version": {
						GET: this.protect(async () => await handleGetVersion()),
					},
					"/api/statistics": {
						GET: this.protect(async () => await handleGetStatistics(this.core)),
					},
					"/api/status": {
						GET: this.protect(async () => await handleGetStatus(this.core)),
					},
					"/api/init": {
						POST: this.protect(
							async (req: Request) =>
								await handleInit(req, this.core, this.contentStore, (name) => {
									this.projectName = name;
								}),
						),
					},
					"/api/search": {
						GET: this.protect(async (req: Request) => await handleSearch(req, this.core)),
					},
					"/sequences": {
						GET: this.protect(async () => await handleGetSequences(this.core)),
					},
					"/sequences/move": {
						POST: this.protect(async (req: Request) => await handleMoveSequence(req, this.core)),
					},
					"/api/sequences": {
						GET: this.protect(async () => await handleGetSequences(this.core)),
					},
					"/api/sequences/move": {
						POST: this.protect(async (req: Request) => await handleMoveSequence(req, this.core)),
					},
					"/api/users": {
						GET: async () => {
							const users = this.configRepoService?.listUsers() ?? [];
							return Response.json(users.map(({ email, name }) => ({ email, name })));
						},
					},
					"/api/auth/status": {
						GET: async () => {
							return Response.json({
								enabled: this.authEnabled,
								clientId: this.authEnabled ? this.googleClientId : undefined,
							});
						},
					},
					"/api/auth/google": {
						POST: async (req: Request) =>
							await handleGoogleLogin(
								req,
								this.authEnabled,
								this.googleClientId,
								this.configRepoService,
								this.jwtSecret,
							),
					},
					"/api/auth/me": {
						GET: this.protect(async (req: Request) => await handleGetMe(req, this.jwtSecret)),
					},
					// Serve files placed under backlog/assets at /assets/<relative-path>
					"/assets/*": {
						GET: async (req: Request) => await this.handleAssetRequest(req),
					},
				},
				fetch: async (req: Request, server: Server<unknown>) => {
					const res = await this.handleRequest(req, server);

					// Disable caching for GET/HEAD so browser always fetches latest content
					if (req.method === "GET" || req.method === "HEAD") {
						res.headers.set("Cache-Control", "no-store, max-age=0, must-revalidate");
						res.headers.set("Pragma", "no-cache");
						res.headers.set("Expires", "0");
					}

					return res;
				},
				error: this.handleError.bind(this),
				websocket: {
					open: (ws: ServerWebSocket) => {
						this.sockets.add(ws);
					},
					message(ws: ServerWebSocket) {
						ws.send("pong");
					},
					close: (ws: ServerWebSocket) => {
						this.sockets.delete(ws);
					},
				},
				/* biome-ignore format: keep cast on single line below for type narrowing */
			};
			this.server = Bun.serve(serveOptions as unknown as Parameters<typeof Bun.serve>[0]);

			const url = `http://localhost:${finalPort}`;
			console.log(`🚀 Backlog.md browser interface running at ${url}`);
			console.log(`🔌 MCP endpoint: ${url}/mcp`);
			console.log(`📊 Project: ${this.projectName}`);
			const stopKey = process.platform === "darwin" ? "Cmd+C" : "Ctrl+C";
			console.log(`⏹️  Press ${stopKey} to stop the server`);

			if (shouldOpenBrowser) {
				console.log("🌐 Opening browser...");
				await this.openBrowser(url);
			} else {
				console.log("💡 Open your browser and navigate to the URL above");
			}
		} catch (error) {
			// Handle port already in use error
			const errorCode = (error as { code?: string })?.code;
			const errorMessage = (error as Error)?.message;
			if (errorCode === "EADDRINUSE" || errorMessage?.includes("address already in use")) {
				console.error(`\n❌ Error: Port ${finalPort} is already in use.\n`);
				console.log("💡 Suggestions:");
				console.log(`   1. Try a different port: backlog browser --port ${finalPort + 1}`);
				console.log(`   2. Find what's using port ${finalPort}:`);
				if (process.platform === "darwin" || process.platform === "linux") {
					console.log(`      Run: lsof -i :${finalPort}`);
				} else if (process.platform === "win32") {
					console.log(`      Run: netstat -ano | findstr :${finalPort}`);
				}
				console.log("   3. Or kill the process using the port and try again\n");
				process.exit(1);
			}

			// Handle other errors
			console.error("❌ Failed to start server:", errorMessage || error);
			process.exit(1);
		}
	}

	private _stopping = false;

	async stop(): Promise<void> {
		if (this._stopping) return;
		this._stopping = true;

		// Stop filesystem watcher first to reduce churn
		try {
			this.unsubscribeContentStore?.();
			this.unsubscribeContentStore = undefined;
		} catch {}

		// Stop config watcher
		try {
			this.configWatcher?.stop();
			this.configWatcher = null;
		} catch {}

		// Stop MCP handler
		try {
			await this.mcpHandler?.stop();
			this.mcpHandler = null;
		} catch {}

		// Stop config repo service
		try {
			await this.configRepoService?.stop();
			this.configRepoService = null;
		} catch {}

		// Stop project repo service (cleans up temp clone)
		try {
			await this.projectRepoService?.stop();
			this.projectRepoService = null;
		} catch {}

		this.core.disposeSearchService();
		this.core.disposeContentStore();
		this.contentStore = null;
		this.storeReadyBroadcasted = false;

		// Proactively close WebSocket connections
		for (const ws of this.sockets) {
			try {
				ws.close();
			} catch {}
		}
		this.sockets.clear();

		// Attempt to stop the server but don't hang forever
		if (this.server) {
			const serverRef = this.server;
			const stopPromise = (async () => {
				try {
					await serverRef.stop();
				} catch {}
			})();
			const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
			await Promise.race([stopPromise, timeout]);
			this.server = null;
			console.log("Server stopped");
		}

		this._stopping = false;
	}

	private async openBrowser(url: string): Promise<void> {
		try {
			const platform = process.platform;
			let cmd: string[];

			switch (platform) {
				case "darwin": // macOS
					cmd = ["open", url];
					break;
				case "win32": // Windows
					cmd = ["cmd", "/c", "start", "", url];
					break;
				default: // Linux and others
					cmd = ["xdg-open", url];
					break;
			}

			await $`${cmd}`.quiet();
		} catch (error) {
			console.warn("⚠️  Failed to open browser automatically:", error);
			console.log("💡 Please open your browser manually and navigate to the URL above");
		}
	}

	private async handleAssetRequest(req: Request): Promise<Response> {
		try {
			const url = new URL(req.url);
			const pathname = decodeURIComponent(url.pathname || "");
			const prefix = "/assets/";
			if (!pathname.startsWith(prefix)) return new Response("Not Found", { status: 404 });

			// Path relative to backlog/assets
			const relPath = pathname.slice(prefix.length);

			// disallow traversal
			if (relPath.includes("..")) return new Response("Not Found", { status: 404 });

			// derive backlog root from docsDir (parent of backlog/docs)
			const docsDir = this.core.filesystem.docsDir;
			const backlogRoot = dirname(docsDir);
			const assetsRoot = join(backlogRoot, "assets");
			const filePath = join(assetsRoot, relPath);

			if (!filePath.startsWith(assetsRoot)) return new Response("Not Found", { status: 404 });

			const file = Bun.file(filePath);
			if (!(await file.exists())) return new Response("Not Found", { status: 404 });

			const ext = (filePath.match(/\.([^./]+)$/) || [])[1]?.toLowerCase() || "";
			const mimeMap: Record<string, string> = {
				png: "image/png",
				jpg: "image/jpeg",
				jpeg: "image/jpeg",
				gif: "image/gif",
				svg: "image/svg+xml",
				webp: "image/webp",
				avif: "image/avif",
				pdf: "application/pdf",
				txt: "text/plain",
				css: "text/css",
				js: "application/javascript",
			};

			const mime = mimeMap[ext] ?? "application/octet-stream";
			return new Response(file, { headers: { "Content-Type": mime } });
		} catch (error) {
			console.error("Error serving asset:", error);
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	private async handleRequest(req: Request, server: Server<unknown>): Promise<Response> {
		const url = new URL(req.url);
		const pathname = url.pathname;

		// Handle WebSocket upgrade
		if (req.headers.get("upgrade") === "websocket") {
			const success = server.upgrade(req, { data: undefined });
			if (success) {
				return new Response(null, { status: 101 }); // WebSocket upgrade response
			}
			return new Response("WebSocket upgrade failed", { status: 400 });
		}

		// MCP endpoint — delegates to the stateless MCP request handler
		if (pathname === "/mcp") {
			if (!this.mcpHandler) {
				return new Response("MCP not ready", { status: 503 });
			}
			return this.mcpHandler.handleRequest(req);
		}

		// Workaround as Bun doesn't support images imported from link tags in HTML
		if (pathname.startsWith("/favicon")) {
			const faviconFile = Bun.file(favicon);
			return new Response(faviconFile, {
				headers: { "Content-Type": "image/png" },
			});
		}

		// For all other routes, return 404 since routes should handle all valid paths
		return new Response("Not Found", { status: 404 });
	}

	private handleError(error: Error): Response {
		console.error("Server Error:", error);
		return new Response("Internal Server Error", { status: 500 });
	}
}
