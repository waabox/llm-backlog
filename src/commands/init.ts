import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { spawn } from "bun";
import type { Command } from "commander";
import prompts from "prompts";
import { initializeProject } from "../core/init.ts";
import {
	type AgentInstructionFile,
	Core,
	type EnsureMcpGuidelinesResult,
	ensureMcpGuidelines,
	initializeGitRepository,
	isGitRepository,
} from "../index.ts";
import type { BacklogConfig } from "../types/index.ts";
import { promptText } from "../ui/tui.ts";
import { type AgentSelectionValue, PLACEHOLDER_AGENT_VALUE, processAgentSelection } from "../utils/agent-selection.ts";
import { runAdvancedConfigWizard } from "./advanced-config-wizard.ts";
import { type CompletionInstallResult, installCompletion } from "./completion.ts";
import { getDefaultAdvancedConfig } from "./shared.ts";

type IntegrationMode = "mcp" | "cli" | "none";

function normalizeIntegrationOption(value: string): IntegrationMode | null {
	const normalized = value.trim().toLowerCase();
	if (
		normalized === "mcp" ||
		normalized === "connector" ||
		normalized === "model-context-protocol" ||
		normalized === "model_context_protocol"
	) {
		return "mcp";
	}
	if (
		normalized === "cli" ||
		normalized === "legacy" ||
		normalized === "commands" ||
		normalized === "command" ||
		normalized === "instructions" ||
		normalized === "instruction" ||
		normalized === "agent" ||
		normalized === "agents"
	) {
		return "cli";
	}
	if (
		normalized === "none" ||
		normalized === "skip" ||
		normalized === "manual" ||
		normalized === "later" ||
		normalized === "no" ||
		normalized === "off"
	) {
		return "none";
	}
	return null;
}

// Always use "backlog" as the global MCP server name so fallback mode works when the project isn't initialized.
const MCP_SERVER_NAME = "backlog";

const MCP_CLIENT_INSTRUCTION_MAP: Record<string, AgentInstructionFile> = {
	claude: "CLAUDE.md",
	codex: "AGENTS.md",
	gemini: "GEMINI.md",
	kiro: "AGENTS.md",
	guide: "AGENTS.md",
};

async function openUrlInBrowser(url: string): Promise<void> {
	let cmd: string[];
	if (process.platform === "darwin") {
		cmd = ["open", url];
	} else if (process.platform === "win32") {
		cmd = ["cmd", "/c", "start", "", url];
	} else {
		cmd = ["xdg-open", url];
	}
	try {
		const { $ } = await import("bun");
		await $`${cmd}`.quiet();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`  ⚠️  Unable to open browser automatically (${message}). Please visit ${url}`);
	}
}

async function runMcpClientCommand(label: string, command: string, args: string[]): Promise<string> {
	console.log(`    Configuring ${label}...`);
	try {
		const child = spawn({
			cmd: [command, ...args],
			stdout: "inherit",
			stderr: "inherit",
		});
		await child.exited;
		console.log(`    ✓ Added Backlog MCP server to ${label}`);
		return label;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`    ⚠️ Unable to configure ${label} automatically (${message}).`);
		console.warn(`       Run manually: ${command} ${args.join(" ")}`);
		return `${label} (manual setup required)`;
	}
}

/**
 * Register the init command for initializing a new Backlog.md project.
 *
 * @param program - Commander program instance
 */
export function registerInitCommand(program: Command): void {
	program
		.command("init [projectName]")
		.description("initialize backlog project in the current repository")
		.option(
			"--agent-instructions <instructions>",
			"comma-separated agent instructions to create. Valid: claude, agents, gemini, copilot, cursor (alias of agents), none. Use 'none' to skip; when combined with others, 'none' is ignored.",
		)
		.option("--check-branches <boolean>", "check task states across active branches (default: true)")
		.option("--include-remote <boolean>", "include remote branches when checking (default: true)")
		.option("--branch-days <number>", "days to consider branch active (default: 30)")
		.option("--bypass-git-hooks <boolean>", "bypass git hooks when committing (default: false)")
		.option("--zero-padded-ids <number>", "number of digits for zero-padding IDs (0 to disable)")
		.option("--default-editor <editor>", "default editor command")
		.option("--web-port <number>", "default web UI port (default: 6420)")
		.option("--auto-open-browser <boolean>", "auto-open browser for web UI (default: true)")
		.option("--install-claude-agent <boolean>", "install Claude Code agent (default: false)")
		.option("--integration-mode <mode>", "choose how AI tools connect to Backlog.md (mcp, cli, or none)")
		.option("--task-prefix <prefix>", "custom task prefix, letters only (default: task)")
		.option("--defaults", "use default values for all prompts")
		.action(
			async (
				projectName: string | undefined,
				options: {
					agentInstructions?: string;
					checkBranches?: string;
					includeRemote?: string;
					branchDays?: string;
					bypassGitHooks?: string;
					zeroPaddedIds?: string;
					defaultEditor?: string;
					webPort?: string;
					autoOpenBrowser?: string;
					installClaudeAgent?: string;
					integrationMode?: string;
					taskPrefix?: string;
					defaults?: boolean;
				},
			) => {
				try {
					// init command uses process.cwd() directly - it initializes in the current directory
					const cwd = process.cwd();
					const isRepo = await isGitRepository(cwd);

					if (!isRepo) {
						const rl = createInterface({ input, output });
						const answer = (await rl.question("No git repository found. Initialize one here? [y/N] "))
							.trim()
							.toLowerCase();
						rl.close();

						if (answer.startsWith("y")) {
							await initializeGitRepository(cwd);
						} else {
							console.log("Aborting initialization.");
							process.exit(1);
						}
					}

					const core = new Core(cwd);

					// Check if project is already initialized and load existing config
					const existingConfig = await core.filesystem.loadConfig();
					const isReInitialization = !!existingConfig;

					if (isReInitialization) {
						console.log(
							"Existing backlog project detected. Current configuration will be preserved where not specified.",
						);
					}

					// Helper function to parse boolean strings
					const parseBoolean = (value: string | undefined, defaultValue: boolean): boolean => {
						if (value === undefined) return defaultValue;
						return value.toLowerCase() === "true" || value === "1";
					};

					// Helper function to parse number strings
					const parseNumber = (value: string | undefined, defaultValue: number): number => {
						if (value === undefined) return defaultValue;
						const parsed = Number.parseInt(value, 10);
						return Number.isNaN(parsed) ? defaultValue : parsed;
					};

					// Non-interactive mode when any flag is provided or --defaults is used
					const isNonInteractive = !!(
						options.agentInstructions ||
						options.defaults ||
						options.checkBranches ||
						options.includeRemote ||
						options.branchDays ||
						options.bypassGitHooks ||
						options.zeroPaddedIds ||
						options.defaultEditor ||
						options.webPort ||
						options.autoOpenBrowser ||
						options.installClaudeAgent ||
						options.integrationMode ||
						options.taskPrefix
					);

					// Get project name
					let name = projectName;
					if (!name) {
						const defaultName = existingConfig?.projectName || "";
						const promptMessage =
							isReInitialization && defaultName ? `Project name (${defaultName}):` : "Project name:";
						name = await promptText(promptMessage);
						// Use existing name if nothing entered during re-init
						if (!name && isReInitialization && defaultName) {
							name = defaultName;
						}
						if (!name) {
							console.log("Aborting initialization.");
							process.exit(1);
						}
					}

					// Get task prefix (first-time init only, preserved on re-init)
					let taskPrefix = options.taskPrefix;
					if (!taskPrefix && !isNonInteractive && !isReInitialization) {
						taskPrefix = await promptText("Task prefix (default: task):");
					}
					// Validate task prefix if provided
					if (taskPrefix && !/^[a-zA-Z]+$/.test(taskPrefix)) {
						console.error("Task prefix must contain only letters (a-z, A-Z).");
						process.exit(1);
					}

					const defaultAdvancedConfig = getDefaultAdvancedConfig(existingConfig);
					const applyAdvancedOptionOverrides = () => {
						const result: Partial<BacklogConfig> = { ...defaultAdvancedConfig };
						result.checkActiveBranches = parseBoolean(options.checkBranches, result.checkActiveBranches ?? true);
						if (result.checkActiveBranches) {
							result.remoteOperations = parseBoolean(options.includeRemote, result.remoteOperations ?? true);
							result.activeBranchDays = parseNumber(options.branchDays, result.activeBranchDays ?? 30);
						} else {
							result.remoteOperations = false;
						}
						result.bypassGitHooks = parseBoolean(options.bypassGitHooks, result.bypassGitHooks ?? false);
						const paddingValue = parseNumber(options.zeroPaddedIds, result.zeroPaddedIds ?? 0);
						result.zeroPaddedIds = paddingValue > 0 ? paddingValue : undefined;
						result.defaultEditor =
							options.defaultEditor ||
							existingConfig?.defaultEditor ||
							process.env.EDITOR ||
							process.env.VISUAL ||
							undefined;
						result.defaultPort = parseNumber(options.webPort, result.defaultPort ?? 6420);
						result.autoOpenBrowser = parseBoolean(options.autoOpenBrowser, result.autoOpenBrowser ?? true);
						return result;
					};

					const integrationOption = options.integrationMode
						? normalizeIntegrationOption(options.integrationMode)
						: undefined;
					if (options.integrationMode && !integrationOption) {
						console.error(`Invalid integration mode: ${options.integrationMode}. Valid options are: mcp, cli, none`);
						process.exit(1);
					}

					let integrationMode: IntegrationMode | null = integrationOption ?? (isNonInteractive ? "mcp" : null);
					const mcpServerName = MCP_SERVER_NAME;
					type AgentSelection = AgentSelectionValue;
					let agentFiles: AgentInstructionFile[] = [];
					let agentInstructionsSkipped = false;
					let mcpClientSetupSummary: string | undefined;
					const mcpGuideUrl = "https://github.com/MrLesk/Backlog.md#-mcp-integration-model-context-protocol";

					if (
						!integrationOption &&
						integrationMode === "mcp" &&
						(options.agentInstructions || options.installClaudeAgent)
					) {
						integrationMode = "cli";
					}

					if (integrationMode === "mcp" && (options.agentInstructions || options.installClaudeAgent)) {
						console.error(
							"The MCP connector option cannot be combined with --agent-instructions or --install-claude-agent.",
						);
						process.exit(1);
					}

					if (integrationMode === "none" && (options.agentInstructions || options.installClaudeAgent)) {
						console.error(
							"Skipping AI integration cannot be combined with --agent-instructions or --install-claude-agent.",
						);
						process.exit(1);
					}

					mainSelection: while (true) {
						if (integrationMode === null) {
							let cancelled = false;
							const integrationPrompt = await prompts(
								{
									type: "select",
									name: "mode",
									message: "How would you like your AI tools to connect to Backlog.md?",
									hint: "Pick MCP when your editor supports the Model Context Protocol.",
									initial: 0,
									choices: [
										{
											title: "via MCP connector (recommended for Claude Code, Codex, Gemini CLI, Kiro, Cursor, etc.)",
											description: "Agents learn the Backlog.md workflow through MCP tools, resources, and prompts.",
											value: "mcp",
										},
										{
											title: "via CLI commands (broader compatibility)",
											description: "Agents will use Backlog.md by invoking CLI commands directly",
											value: "cli",
										},
										{
											title: "Skip for now (I am not using Backlog.md with AI tools)",
											description: "Continue without setting up MCP or instruction files.",
											value: "none",
										},
									],
								},
								{
									onCancel: () => {
										cancelled = true;
									},
								},
							);

							if (cancelled) {
								console.log("Initialization cancelled.");
								return;
							}

							const selectedMode = integrationPrompt?.mode
								? normalizeIntegrationOption(String(integrationPrompt.mode))
								: null;
							integrationMode = selectedMode ?? "mcp";
							console.log("");
						}

						if (integrationMode === "cli") {
							if (options.agentInstructions) {
								const nameMap: Record<string, AgentSelection> = {
									cursor: "AGENTS.md",
									claude: "CLAUDE.md",
									agents: "AGENTS.md",
									gemini: "GEMINI.md",
									copilot: ".github/copilot-instructions.md",
									none: "none",
									"CLAUDE.md": "CLAUDE.md",
									"AGENTS.md": "AGENTS.md",
									"GEMINI.md": "GEMINI.md",
									".github/copilot-instructions.md": ".github/copilot-instructions.md",
								};

								const requestedInstructions = options.agentInstructions.split(",").map((f) => f.trim().toLowerCase());
								const mappedFiles: AgentSelection[] = [];

								for (const instruction of requestedInstructions) {
									const mappedFile = nameMap[instruction];
									if (!mappedFile) {
										console.error(`Invalid agent instruction: ${instruction}`);
										console.error("Valid options are: cursor, claude, agents, gemini, copilot, none");
										process.exit(1);
									}
									mappedFiles.push(mappedFile);
								}

								const { files, needsRetry, skipped } = processAgentSelection({ selected: mappedFiles });
								if (needsRetry) {
									console.error("Please select at least one agent instruction file before continuing.");
									process.exit(1);
								}
								agentFiles = files;
								agentInstructionsSkipped = skipped;
							} else if (isNonInteractive) {
								agentFiles = [];
							} else {
								const defaultHint = "Enter selects highlighted agent (after moving); space toggles selections\n";
								while (true) {
									let highlighted: AgentSelection | undefined;
									let initialCursor: number | undefined;
									let cursorMoved = false;
									let selectionCancelled = false;
									const response = await prompts(
										{
											type: "multiselect",
											name: "files",
											message: "Select instruction files for CLI-based AI tools",
											choices: [
												{
													title: "↓ Use space to toggle instruction files (enter accepts)",
													value: PLACEHOLDER_AGENT_VALUE,
													disabled: true,
												},
												{ title: "CLAUDE.md — Claude Code", value: "CLAUDE.md" },
												{
													title: "AGENTS.md — Codex, Cursor, Zed, Warp, Aider, RooCode, etc.",
													value: "AGENTS.md",
												},
												{ title: "GEMINI.md — Google Gemini Code Assist CLI", value: "GEMINI.md" },
												{ title: "Copilot instructions — GitHub Copilot", value: ".github/copilot-instructions.md" },
											],
											hint: defaultHint,
											instructions: false,
											onRender: function () {
												try {
													const promptInstance = this as unknown as {
														cursor: number;
														value: Array<{ value: AgentSelection }>;
														hint: string;
													};
													if (initialCursor === undefined) {
														initialCursor = promptInstance.cursor;
													}
													if (initialCursor !== undefined && promptInstance.cursor !== initialCursor) {
														cursorMoved = true;
													}
													const focus = promptInstance.value?.[promptInstance.cursor];
													highlighted = focus?.value;
													promptInstance.hint = defaultHint;
												} catch {}
												return undefined;
											},
										},
										{
											onCancel: () => {
												selectionCancelled = true;
											},
										},
									);

									if (selectionCancelled) {
										integrationMode = null;
										console.log("");
										continue mainSelection;
									}

									const rawSelection = (response?.files ?? []) as AgentSelection[];
									const selected =
										rawSelection.length === 0 &&
										highlighted &&
										highlighted !== PLACEHOLDER_AGENT_VALUE &&
										highlighted !== "none"
											? [highlighted]
											: rawSelection;
									const { files, needsRetry, skipped } = processAgentSelection({
										selected,
										highlighted,
										useHighlightFallback: cursorMoved,
									});
									if (needsRetry) {
										console.log("Please select at least one agent instruction file before continuing.");
										continue;
									}
									agentFiles = files;
									agentInstructionsSkipped = skipped;
									break;
								}
							}

							break;
						}

						if (integrationMode === "mcp") {
							if (isNonInteractive) {
								mcpClientSetupSummary = "skipped (non-interactive)";
								break;
							}

							console.log(`  MCP server name: ${mcpServerName}`);
							while (true) {
								let clientSelectionCancelled = false;
								let highlightedClient: string | undefined;
								const clientResponse = await prompts(
									{
										type: "multiselect",
										name: "clients",
										message: "Which AI tools should we configure right now?",
										hint: "Space toggles items • Enter confirms (leave empty to skip)",
										instructions: false,
										choices: [
											{ title: "Claude Code", value: "claude" },
											{ title: "OpenAI Codex", value: "codex" },
											{ title: "Gemini CLI", value: "gemini" },
											{ title: "Kiro", value: "kiro" },
											{ title: "Other (open setup guide)", value: "guide" },
										],
										onRender: function () {
											try {
												const promptInstance = this as unknown as {
													cursor: number;
													value: Array<{ value: string }>;
												};
												highlightedClient = promptInstance.value?.[promptInstance.cursor]?.value;
											} catch {}
											return undefined;
										},
									},
									{
										onCancel: () => {
											clientSelectionCancelled = true;
										},
									},
								);

								if (clientSelectionCancelled) {
									integrationMode = null;
									console.log("");
									continue mainSelection;
								}

								const rawClients = (clientResponse?.clients ?? []) as string[];
								const selectedClients = rawClients.length === 0 && highlightedClient ? [highlightedClient] : rawClients;
								highlightedClient = undefined;
								if (selectedClients.length === 0) {
									console.log("  MCP client setup skipped (configure later if needed).");
									mcpClientSetupSummary = "skipped";
									break;
								}

								const results: string[] = [];
								const mcpGuidelineUpdates: EnsureMcpGuidelinesResult[] = [];
								const recordGuidelinesForClient = async (clientKey: string) => {
									const instructionFile = MCP_CLIENT_INSTRUCTION_MAP[clientKey];
									if (!instructionFile) {
										return;
									}
									const nudgeResult = await ensureMcpGuidelines(cwd, instructionFile);
									if (nudgeResult.changed) {
										mcpGuidelineUpdates.push(nudgeResult);
									}
								};
								const uniq = (values: string[]) => [...new Set(values)];

								for (const client of selectedClients) {
									if (client === "claude") {
										const result = await runMcpClientCommand("Claude Code", "claude", [
											"mcp",
											"add",
											"-s",
											"user",
											mcpServerName,
											"--",
											"backlog",
											"mcp",
											"start",
										]);
										results.push(result);
										await recordGuidelinesForClient(client);
										continue;
									}
									if (client === "codex") {
										const result = await runMcpClientCommand("OpenAI Codex", "codex", [
											"mcp",
											"add",
											mcpServerName,
											"backlog",
											"mcp",
											"start",
										]);
										results.push(result);
										await recordGuidelinesForClient(client);
										continue;
									}
									if (client === "gemini") {
										const result = await runMcpClientCommand("Gemini CLI", "gemini", [
											"mcp",
											"add",
											"-s",
											"user",
											mcpServerName,
											"backlog",
											"mcp",
											"start",
										]);
										results.push(result);
										await recordGuidelinesForClient(client);
										continue;
									}
									if (client === "kiro") {
										const result = await runMcpClientCommand("Kiro", "kiro-cli", [
											"mcp",
											"add",
											"--scope",
											"global",
											"--name",
											mcpServerName,
											"--command",
											"backlog",
											"--args",
											"mcp,start",
										]);
										results.push(result);
										await recordGuidelinesForClient(client);
										continue;
									}
									if (client === "guide") {
										console.log("    Opening MCP setup guide in your browser...");
										await openUrlInBrowser(mcpGuideUrl);
										results.push("Setup guide opened");
										await recordGuidelinesForClient(client);
									}
								}

								if (mcpGuidelineUpdates.length > 0) {
									const createdFiles = uniq(
										mcpGuidelineUpdates.filter((entry) => entry.created).map((entry) => entry.fileName),
									);
									const updatedFiles = uniq(
										mcpGuidelineUpdates.filter((entry) => !entry.created).map((entry) => entry.fileName),
									);
									if (createdFiles.length > 0) {
										console.log(`    Created MCP reminder file(s): ${createdFiles.join(", ")}`);
									}
									if (updatedFiles.length > 0) {
										console.log(`    Added MCP reminder to ${updatedFiles.join(", ")}`);
									}
								}

								mcpClientSetupSummary = results.join(", ");
								break;
							}

							break;
						}

						if (integrationMode === "none") {
							agentFiles = [];
							agentInstructionsSkipped = false;
							break;
						}
					}

					let advancedConfig: Partial<BacklogConfig> = { ...defaultAdvancedConfig };
					let advancedConfigured = false;
					let installClaudeAgentSelection = false;
					let installShellCompletionsSelection = false;
					let completionInstallResult: CompletionInstallResult | null = null;
					let completionInstallError: string | null = null;

					if (isNonInteractive) {
						advancedConfig = applyAdvancedOptionOverrides();
						installClaudeAgentSelection =
							integrationMode === "cli" ? parseBoolean(options.installClaudeAgent, false) : false;
					} else {
						const advancedPrompt = await prompts(
							{
								type: "confirm",
								name: "configureAdvanced",
								message: "Configure advanced settings now?",
								hint: "Runs the advanced backlog config wizard",
								initial: false,
							},
							{
								onCancel: () => {
									console.log("Aborting initialization.");
									process.exit(1);
								},
							},
						);

						if (advancedPrompt.configureAdvanced) {
							const wizardResult = await runAdvancedConfigWizard({
								existingConfig,
								cancelMessage: "Aborting initialization.",
								includeClaudePrompt: integrationMode === "cli",
							});
							advancedConfig = { ...defaultAdvancedConfig, ...wizardResult.config };
							installClaudeAgentSelection = integrationMode === "cli" ? wizardResult.installClaudeAgent : false;
							installShellCompletionsSelection = wizardResult.installShellCompletions;
							if (wizardResult.installShellCompletions) {
								try {
									completionInstallResult = await installCompletion();
								} catch (error) {
									completionInstallError = error instanceof Error ? error.message : String(error);
								}
							}
							advancedConfigured = true;
						}
					}
					// Call shared core init function
					const initResult = await initializeProject(core, {
						projectName: name,
						integrationMode: integrationMode || "none",
						mcpClients: [], // MCP clients are handled separately in CLI with interactive prompts
						agentInstructions: agentFiles,
						installClaudeAgent: installClaudeAgentSelection,
						advancedConfig: {
							checkActiveBranches: advancedConfig.checkActiveBranches,
							remoteOperations: advancedConfig.remoteOperations,
							activeBranchDays: advancedConfig.activeBranchDays,
							bypassGitHooks: advancedConfig.bypassGitHooks,
							autoCommit: advancedConfig.autoCommit,
							zeroPaddedIds: advancedConfig.zeroPaddedIds,
							defaultEditor: advancedConfig.defaultEditor,
							defaultPort: advancedConfig.defaultPort,
							autoOpenBrowser: advancedConfig.autoOpenBrowser,
							taskPrefix: taskPrefix || undefined,
						},
						existingConfig,
					});

					const config = initResult.config;

					// Show configuration summary
					console.log("\nInitialization Summary:");
					console.log(`  Project Name: ${config.projectName}`);
					if (integrationMode === "cli") {
						console.log("  AI Integration: CLI commands (legacy)");
						if (agentFiles.length > 0) {
							console.log(`  Agent instructions: ${agentFiles.join(", ")}`);
						} else if (agentInstructionsSkipped) {
							console.log("  Agent instructions: skipped");
						} else {
							console.log("  Agent instructions: none");
						}
					} else if (integrationMode === "mcp") {
						console.log("  AI Integration: MCP connector");
						console.log("  Agent instruction files: guidance is provided through the MCP connector.");
						console.log(`  MCP server name: ${mcpServerName}`);
						console.log(`  MCP client setup: ${mcpClientSetupSummary ?? "skipped"}`);
					} else {
						console.log(
							"  AI integration skipped. Configure later via `backlog init` or by registering the MCP server manually.",
						);
					}
					let completionSummary: string;
					if (completionInstallResult) {
						completionSummary = `installed to ${completionInstallResult.installPath}`;
					} else if (installShellCompletionsSelection) {
						completionSummary = "installation failed (see warning below)";
					} else if (advancedConfigured) {
						completionSummary = "skipped";
					} else {
						completionSummary = "not configured";
					}
					console.log(`  Shell completions: ${completionSummary}`);
					if (advancedConfigured) {
						console.log("  Advanced settings:");
						console.log(`    Check active branches: ${config.checkActiveBranches}`);
						console.log(`    Remote operations: ${config.remoteOperations}`);
						console.log(`    Active branch days: ${config.activeBranchDays}`);
						console.log(`    Bypass git hooks: ${config.bypassGitHooks}`);
						console.log(`    Auto commit: ${config.autoCommit}`);
						console.log(`    Zero-padded IDs: ${config.zeroPaddedIds ? `${config.zeroPaddedIds} digits` : "disabled"}`);
						console.log(`    Web UI port: ${config.defaultPort}`);
						console.log(`    Auto open browser: ${config.autoOpenBrowser}`);
						if (config.defaultEditor) {
							console.log(`    Default editor: ${config.defaultEditor}`);
						}
					} else {
						console.log("  Advanced settings: unchanged (run `backlog config` to customize).");
					}
					console.log("");

					if (completionInstallResult) {
						const instructions = completionInstallResult.instructions.trim();
						console.log(
							[
								`Shell completion script installed for ${completionInstallResult.shell}.`,
								`  Path: ${completionInstallResult.installPath}`,
								instructions,
								"",
							].join("\n"),
						);
					} else if (completionInstallError) {
						const indentedError = completionInstallError
							.split("\n")
							.map((line) => `  ${line}`)
							.join("\n");
						console.warn(
							`⚠️  Shell completion installation failed:\n${indentedError}\n  Run \`backlog completion install\` later to retry.\n`,
						);
					}

					// Log init result
					if (initResult.isReInitialization) {
						console.log(`Updated backlog project configuration: ${name}`);
					} else {
						console.log(`Initialized backlog project: ${name}`);
					}

					// Log agent files result from shared init
					if (integrationMode === "cli") {
						if (initResult.mcpResults?.agentFiles) {
							console.log(`✓ ${initResult.mcpResults.agentFiles}`);
						} else if (agentInstructionsSkipped) {
							console.log("Skipping agent instruction files per selection.");
						}
					}

					// Log Claude agent result from shared init
					if (integrationMode === "cli" && initResult.mcpResults?.claudeAgent) {
						console.log(`✓ Claude Code Backlog.md agent ${initResult.mcpResults.claudeAgent}`);
					}

					// Final warning if remote operations were enabled but no git remotes are configured
					try {
						if (config.remoteOperations) {
							// Ensure git ops are ready (config not strictly required for this check)
							const hasRemotes = await core.gitOps.hasAnyRemote();
							if (!hasRemotes) {
								console.warn(
									[
										"Warning: remoteOperations is enabled but no git remotes are configured.",
										"Remote features will be skipped until a remote is added (e.g., 'git remote add origin <url>')",
										"or disable remoteOperations via 'backlog config set remoteOperations false'.",
									].join(" "),
								);
							}
						}
					} catch {
						// Ignore failures in final advisory warning
					}
				} catch (err) {
					console.error("Failed to initialize project", err);
					process.exitCode = 1;
				}
			},
		);
}
