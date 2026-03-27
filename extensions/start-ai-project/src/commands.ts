import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi, PluginCommandContext } from "../runtime-api.js";
import { addWorktree, checkoutNewBranch, copyRepo, detectVerifyCommands, getDefaultBranch, getRepoRoot, listPackages } from "./git.js";
import { openCursorWorkspace } from "./open.js";
import { removeGitExclude, scaffold, unskipWorktreeTracked } from "./scaffold.js";
import { loadRepoDescriptors, resolvePluginConfig, type ResolvedStartAiProjectPluginConfig } from "./config.js";
import type { RepoDescriptor, SandboxContext, SandboxResult, StartSandboxRequest } from "./types.js";
import { exec, parseBool, slugify } from "./utils.js";
import {
  clearWizardSession,
  createWizardSession,
  formatConfirmPrompt,
  formatIntentPrompt,
  formatNoVisibleReposText,
  formatPackagePrompt,
  formatRepoListPrompt,
  formatWizardStartHint,
  getWizardSession,
  isWizardCancelInput,
  isWizardConfirmInput,
  resolvePackageChoice,
  resolveRepoChoice,
  saveWizardSession,
  type WizardSession,
} from "./wizard.js";

type RuntimeOptions = {
  pluginConfig: unknown;
  resolvePath: (input: string) => string;
  logger: OpenClawPluginApi["logger"];
};

export function registerStartAiProjectCommands(api: OpenClawPluginApi): void {
  const options: RuntimeOptions = {
    pluginConfig: api.pluginConfig,
    resolvePath: api.resolvePath,
    logger: api.logger,
  };

  api.registerCommand({
    name: "sandbox-repos",
    description: "List configured repositories for sandbox bootstrap.",
    acceptsArgs: false,
    handler: async (ctx) => {
      const repos = await listVisibleReposForContext(options, ctx);
      if (repos.length === 0) {
        return {
          text: formatNoVisibleReposText(resolveRepoVisibilityContext(options, ctx)),
        };
      }
      const lines = repos.map((repo) => `- ${repo.id}: ${repo.path}`);
      return { text: `Configured repositories (${repos.length}):\n${lines.join("\n")}` };
    },
  });

  api.registerCommand({
    name: "sandbox-start",
    description: "Create sandbox copy/worktree, scaffold rules, and return workspace for cursorx.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const rawArgs = ctx.args?.trim() ?? "";
      try {
        if (!rawArgs) {
          return await beginSandboxWizard(ctx, options);
        }
        if (!looksLikeAdvancedStartArgs(rawArgs)) {
          const wizardSession = getWizardSession(ctx);
          if (!wizardSession) {
            return { text: formatWizardStartHint() };
          }
          return await continueSandboxWizard(ctx, rawArgs, wizardSession, options);
        }
        const request = parseStartRequest(rawArgs);
        if (!request.intent?.trim()) {
          return { text: `Usage:\n${sandboxStartUsage()}\n\nTip: send /sandbox-start with no args to use the guided wizard.` };
        }
        clearWizardSession(ctx);
        const result = await startSandbox(request, options);
        return { text: formatSandboxResult(result) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.warn(`[start-ai-project] sandbox-start failed: ${message}`);
        return { text: `sandbox-start failed: ${message}` };
      }
    },
  });

  api.registerCommand({
    name: "sandbox-clean",
    description: "Remove AI scaffold artifacts from an existing sandbox workspace.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const workspace = parseCleanWorkspace(ctx);
      if (!workspace) {
        return {
          text: "Usage: /sandbox-clean workspace=<absolute-path>\nExample: /sandbox-clean workspace=D:\\work\\repo--sandbox--feature",
        };
      }
      try {
        const removed = await cleanSandboxWorkspace(workspace);
        return {
          text:
            `Sandbox cleanup completed for ${workspace}\n` +
            `Removed:\n${removed.map((item) => `- ${item}`).join("\n")}`,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { text: `sandbox-clean failed: ${message}` };
      }
    },
  });
}

export async function listConfiguredRepos(options: RuntimeOptions): Promise<RepoDescriptor[]> {
  const pluginConfig = resolvePluginConfig({
    pluginConfig: options.pluginConfig,
    resolvePath: options.resolvePath,
  });
  return loadRepoDescriptors(pluginConfig);
}

async function listVisibleReposForContext(
  options: RuntimeOptions,
  ctx: PluginCommandContext,
): Promise<RepoDescriptor[]> {
  const pluginConfig = resolvePluginConfig({
    pluginConfig: options.pluginConfig,
    resolvePath: options.resolvePath,
  });
  const repos = await loadRepoDescriptors(pluginConfig);
  return filterReposForContext(repos, pluginConfig, ctx);
}

export function prepareSandboxContext(params: {
  repoRoot: string;
  intent: string;
  targetPackage?: string;
  baseBranch: string;
  taskDir: string;
  verifyCommands: string[];
}): SandboxContext {
  const slug = slugify(params.intent);
  const branch = params.targetPackage
    ? `sandbox/${params.targetPackage}/${slug}`
    : `sandbox/${slug}`;
  const allowedPaths = params.targetPackage ? [`packages/${params.targetPackage}/**`] : ["**"];
  const forbiddenPaths = ["tsconfig*", "**/tsconfig*.json", ".github/**"];
  if (params.targetPackage) {
    forbiddenPaths.push("package.json");
  }
  return {
    intent: params.intent,
    branch,
    baseBranch: params.baseBranch,
    repoRoot: params.repoRoot,
    taskDir: params.taskDir,
    targetPackage: params.targetPackage || "",
    allowedPaths,
    forbiddenPaths,
    verifyCommands: params.verifyCommands,
    uploadsDir: ".ai/uploads",
  };
}

export async function createSandboxCopy(repoRoot: string, taskDir: string, branch: string): Promise<void> {
  await copyRepo(repoRoot, taskDir);
  await checkoutNewBranch(taskDir, branch);
}

export async function createSandboxBranch(
  repoRoot: string,
  taskDir: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await addWorktree(repoRoot, taskDir, branch, baseBranch);
}

export async function writeSandboxScaffold(taskDir: string, context: SandboxContext): Promise<string[]> {
  return scaffold(taskDir, context);
}

export async function installSandboxDependencies(taskDir: string): Promise<void> {
  await exec("pnpm", ["install"], { cwd: taskDir, shell: true });
}

export function resolveCursorWorkspacePath(result: SandboxResult): string {
  return result.workspacePath;
}

export async function startSandbox(
  request: StartSandboxRequest,
  options: RuntimeOptions,
): Promise<SandboxResult> {
  const pluginConfig = resolvePluginConfig({
    pluginConfig: options.pluginConfig,
    resolvePath: options.resolvePath,
  });

  const repos = await loadRepoDescriptors(pluginConfig);
  const resolvedRepo = await resolveTargetRepo({
    request,
    repos,
    reposRoot: pluginConfig.reposRoot,
  });

  const repoRoot = await getRepoRoot(resolvedRepo.path);
  const baseBranch = request.baseBranch || resolvedRepo.defaultBranch || (await getDefaultBranch(repoRoot));
  const verifyCommandsDetected = await detectVerifyCommands(repoRoot, request.targetPackage);
  const verifyCommands =
    verifyCommandsDetected.length > 0 ? verifyCommandsDetected : ["pnpm lint", "pnpm typecheck"];

  const workspacePath = await createWorkspacePath({
    repoRoot,
    intent: request.intent,
    targetPackage: request.targetPackage,
    sandboxRoot: pluginConfig.sandboxRoot,
  });
  await ensureWorkspaceDoesNotExist(workspacePath);

  const context = prepareSandboxContext({
    repoRoot,
    intent: request.intent,
    targetPackage: request.targetPackage,
    baseBranch,
    taskDir: workspacePath,
    verifyCommands,
  });

  const mode = request.mode ?? "copy";
  if (mode === "worktree") {
    await createSandboxBranch(repoRoot, workspacePath, context.branch, context.baseBranch);
  } else {
    await createSandboxCopy(repoRoot, workspacePath, context.branch);
  }

  const createdFiles = await writeSandboxScaffold(workspacePath, context);
  if (request.installDeps) {
    await installSandboxDependencies(workspacePath);
  }
  if (request.openCursor) {
    await openCursorWorkspace(workspacePath);
  }

  return {
    repoId: resolvedRepo.id,
    repoRoot,
    workspacePath,
    branch: context.branch,
    baseBranch: context.baseBranch,
    targetPackage: request.targetPackage,
    verifyCommands,
    mode,
    createdFiles,
  };
}

async function resolveTargetRepo(params: {
  request: StartSandboxRequest;
  repos: RepoDescriptor[];
  reposRoot?: string;
}): Promise<RepoDescriptor> {
  const { request, repos } = params;
  if (request.repoPath) {
    const absolutePath = path.isAbsolute(request.repoPath)
      ? request.repoPath
      : params.reposRoot
        ? path.resolve(params.reposRoot, request.repoPath)
        : path.resolve(request.repoPath);
    return {
      id: request.repoId || path.basename(absolutePath),
      path: absolutePath,
    };
  }

  if (!request.repoId) {
    if (repos.length === 1) {
      return repos[0];
    }
    throw new Error("repoId is required when multiple repositories are configured");
  }

  const matched = repos.find((repo) => repo.id === request.repoId);
  if (!matched) {
    throw new Error(`Unknown repoId "${request.repoId}". Run /sandbox-repos to list options.`);
  }
  return matched;
}

async function createWorkspacePath(params: {
  repoRoot: string;
  intent: string;
  targetPackage?: string;
  sandboxRoot?: string;
}): Promise<string> {
  const repoName = path.basename(params.repoRoot);
  const slug = slugify(params.intent);
  const suffix = params.targetPackage
    ? `${repoName}--sandbox--${params.targetPackage}--${slug}`
    : `${repoName}--sandbox--${slug}`;
  const root = params.sandboxRoot ?? path.resolve(params.repoRoot, "..");
  await fs.mkdir(root, { recursive: true });
  return path.resolve(root, suffix);
}

async function ensureWorkspaceDoesNotExist(workspacePath: string): Promise<void> {
  try {
    await fs.access(workspacePath);
    throw new Error(`Workspace already exists: ${workspacePath}`);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

function parseStartRequest(rawArgs: string): StartSandboxRequest {
  const raw = rawArgs.trim();
  if (!raw) {
    return { intent: "" };
  }

  if (raw.startsWith("{")) {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return normalizeRequest(parsed);
  }

  const parsed = parseKeyValueArgs(raw);
  return normalizeRequest(parsed);
}

function looksLikeAdvancedStartArgs(rawArgs: string): boolean {
  const trimmed = rawArgs.trim();
  return trimmed.startsWith("{") || trimmed.includes("=") || trimmed.includes("--");
}

function resolveRepoVisibilityContext(
  options: RuntimeOptions,
  ctx: PluginCommandContext,
): { isGroup: boolean; groupId?: string } {
  const pluginConfig = resolvePluginConfig({
    pluginConfig: options.pluginConfig,
    resolvePath: options.resolvePath,
  });
  return resolveRepoVisibilityContextFromConfig(pluginConfig, ctx);
}

function resolveRepoVisibilityContextFromConfig(
  pluginConfig: ResolvedStartAiProjectPluginConfig,
  ctx: PluginCommandContext,
): { isGroup: boolean; groupId?: string } {
  const target = (ctx.to ?? "").trim();
  const directPrefixes = ["user:"];
  if (directPrefixes.some((prefix) => target.startsWith(prefix))) {
    return { isGroup: false };
  }
  for (const prefix of ["chat:", "group:", "channel:"]) {
    if (target.startsWith(prefix)) {
      const groupId = target.slice(prefix.length).trim();
      return groupId ? { isGroup: true, groupId } : { isGroup: true };
    }
  }
  if (pluginConfig.groupRepoFilters[target]) {
    return { isGroup: true, groupId: target };
  }
  return { isGroup: false };
}

function filterReposForContext(
  repos: RepoDescriptor[],
  pluginConfig: ResolvedStartAiProjectPluginConfig,
  ctx: PluginCommandContext,
): RepoDescriptor[] {
  const visibility = resolveRepoVisibilityContextFromConfig(pluginConfig, ctx);
  if (!visibility.isGroup) {
    return repos;
  }
  const allowedRepoIds = visibility.groupId ? pluginConfig.groupRepoFilters[visibility.groupId] ?? [] : [];
  if (allowedRepoIds.length === 0) {
    return [];
  }
  const allowed = new Set(allowedRepoIds);
  return repos.filter((repo) => allowed.has(repo.id));
}

async function beginSandboxWizard(
  ctx: PluginCommandContext,
  options: RuntimeOptions,
): Promise<{ text: string }> {
  clearWizardSession(ctx);
  const pluginConfig = resolvePluginConfig({
    pluginConfig: options.pluginConfig,
    resolvePath: options.resolvePath,
  });
  const repos = filterReposForContext(await loadRepoDescriptors(pluginConfig), pluginConfig, ctx);
  const visibility = resolveRepoVisibilityContextFromConfig(pluginConfig, ctx);
  if (repos.length === 0) {
    return { text: formatNoVisibleReposText(visibility) };
  }
  const session = createWizardSession(ctx, repos);
  saveWizardSession(session);
  if (repos.length === 1) {
    return await applyRepoSelection(session, repos[0], options);
  }
  return {
    text: formatRepoListPrompt({
      repos,
      isGroup: visibility.isGroup,
      groupId: visibility.groupId,
    }),
  };
}

async function continueSandboxWizard(
  ctx: PluginCommandContext,
  input: string,
  session: WizardSession,
  options: RuntimeOptions,
): Promise<{ text: string }> {
  if (isWizardCancelInput(input)) {
    clearWizardSession(ctx);
    return { text: "Sandbox setup cancelled." };
  }
  if (session.step === "choose_repo") {
    const selectedRepo = resolveRepoChoice(input, session.visibleRepos);
    if (!selectedRepo) {
      return {
        text:
          "I couldn't match that repository.\n\n" +
          formatRepoListPrompt({ repos: session.visibleRepos, isGroup: false }),
      };
    }
    return await applyRepoSelection(session, selectedRepo, options);
  }
  const selectedRepo = session.visibleRepos.find((repo) => repo.id === session.selectedRepoId);
  if (!selectedRepo) {
    clearWizardSession(ctx);
    return { text: "Sandbox setup expired. Send /sandbox-start to begin again." };
  }
  if (session.step === "choose_package") {
    const selected = resolvePackageChoice(input, session.packageOptions);
    if (!selected.ok) {
      return { text: formatPackagePrompt({ repo: selectedRepo, packageOptions: session.packageOptions }) };
    }
    session.targetPackage = selected.targetPackage;
    session.step = "enter_intent";
    saveWizardSession(session);
    return { text: formatIntentPrompt({ repo: selectedRepo, targetPackage: session.targetPackage }) };
  }
  if (session.step === "enter_intent") {
    const intent = input.trim();
    if (!intent) {
      return { text: formatIntentPrompt({ repo: selectedRepo, targetPackage: session.targetPackage }) };
    }
    session.intent = intent;
    session.step = "confirm";
    saveWizardSession(session);
    return {
      text: formatConfirmPrompt({
        repo: selectedRepo,
        targetPackage: session.targetPackage,
        intent,
        baseBranch: session.baseBranch,
        installDeps: session.installDeps,
        openCursor: session.openCursor,
        mode: session.mode,
      }),
    };
  }
  if (!isWizardConfirmInput(input)) {
    return {
      text:
        formatConfirmPrompt({
          repo: selectedRepo,
          targetPackage: session.targetPackage,
          intent: session.intent || "",
          baseBranch: session.baseBranch,
          installDeps: session.installDeps,
          openCursor: session.openCursor,
          mode: session.mode,
        }) + "\n\nReply /sandbox-start go to create it or /sandbox-start cancel.",
    };
  }
  const result = await startSandbox(
    {
      repoId: selectedRepo.id,
      intent: session.intent || "",
      targetPackage: session.targetPackage,
      baseBranch: session.baseBranch,
      installDeps: session.installDeps,
      openCursor: session.openCursor,
      mode: session.mode,
    },
    options,
  );
  clearWizardSession(ctx);
  return { text: formatSandboxResult(result) };
}

async function applyRepoSelection(
  session: WizardSession,
  repo: RepoDescriptor,
  options: RuntimeOptions,
): Promise<{ text: string }> {
  session.selectedRepoId = repo.id;
  const repoRoot = await getRepoRoot(repo.path);
  const packageOptions = await detectMonorepoPackages(repoRoot);
  session.packageOptions = packageOptions;
  if (packageOptions.length > 0) {
    session.step = "choose_package";
    saveWizardSession(session);
    return { text: formatPackagePrompt({ repo, packageOptions }) };
  }
  session.step = "enter_intent";
  saveWizardSession(session);
  return { text: formatIntentPrompt({ repo }) };
}

function normalizeRequest(raw: Record<string, unknown>): StartSandboxRequest {
  const repoId = asString(raw.repoId ?? raw.repo ?? raw.id);
  const repoPath = asString(raw.repoPath ?? raw.path);
  const intent = asString(raw.intent ?? raw.task ?? raw.message);
  const targetPackage = asString(raw.targetPackage ?? raw.package);
  const baseBranch = asString(raw.baseBranch ?? raw.base);
  const modeRaw = asString(raw.mode);
  const mode = modeRaw === "worktree" ? "worktree" : "copy";
  return {
    repoId,
    repoPath,
    intent: intent || "",
    targetPackage,
    baseBranch,
    openCursor: parseBool(raw.openCursor ?? raw.open, false),
    installDeps: parseBool(raw.installDeps ?? raw.install, true),
    mode,
  };
}

function parseKeyValueArgs(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const tokens = tokenize(raw);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.includes("=")) {
      const [key, ...rest] = token.split("=");
      result[key.trim()] = stripQuotes(rest.join("="));
      continue;
    }
    if (token.startsWith("--")) {
      const key = token.slice(2).trim();
      const next = tokens[index + 1];
      if (!next || next.startsWith("--")) {
        result[key] = "true";
      } else {
        result[key] = stripQuotes(next);
        index += 1;
      }
      continue;
    }
  }
  return result;
}

function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < raw.length; i += 1) {
    const char = raw[i];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      if (!quote) {
        quote = char;
      } else {
        quote = null;
      }
      current += char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function stripQuotes(input: string): string {
  const trimmed = input.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function sandboxStartUsage(): string {
  return [
    "/sandbox-start repoId=<id> intent=\"<task>\" targetPackage=<pkg?> baseBranch=<branch?> installDeps=true openCursor=false mode=copy",
    "/sandbox-start {\"repoId\":\"my-repo\",\"intent\":\"Implement login\",\"targetPackage\":\"web\",\"installDeps\":true}",
    "",
    "Use /sandbox-repos to list configured repoId values.",
  ].join("\n");
}

function formatSandboxResult(result: SandboxResult): string {
  const outputMeta = {
    repoId: result.repoId,
    workspacePath: result.workspacePath,
    branch: result.branch,
    baseBranch: result.baseBranch,
    targetPackage: result.targetPackage || null,
    mode: result.mode,
  };
  return [
    "Sandbox ready.",
    `- repoId: ${result.repoId}`,
    `- mode: ${result.mode}`,
    `- workspace: ${resolveCursorWorkspacePath(result)}`,
    `- branch: ${result.branch}`,
    `- base: ${result.baseBranch}`,
    `- verify: ${result.verifyCommands.join(", ")}`,
    "",
    "For cursorx handoff:",
    `START_AI_PROJECT_WORKSPACE=${resolveCursorWorkspacePath(result)}`,
    `START_AI_PROJECT_META=${JSON.stringify(outputMeta)}`,
  ].join("\n");
}

function parseCleanWorkspace(ctx: PluginCommandContext): string | undefined {
  const args = ctx.args?.trim();
  if (!args) {
    return undefined;
  }
  if (args.startsWith("{")) {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    return asString(parsed.workspace ?? parsed.path);
  }
  const kv = parseKeyValueArgs(args);
  return asString(kv.workspace ?? kv.path);
}

async function cleanSandboxWorkspace(workspacePath: string): Promise<string[]> {
  const targets = [
    path.join(workspacePath, ".ai"),
    path.join(workspacePath, ".cursor", "rules", "ask-plan-build.mdc"),
    path.join(workspacePath, ".cursor", "rules", "ai-sandbox-scope.mdc"),
    path.join(workspacePath, ".cursor", "rules", "chunk-verify.mdc"),
    path.join(workspacePath, ".vscode", "settings.json"),
  ];
  const removed: string[] = [];
  for (const target of targets) {
    await fs.rm(target, { recursive: true, force: true });
    removed.push(path.relative(workspacePath, target));
  }
  await removeGitExclude(workspacePath);
  await unskipWorktreeTracked(workspacePath);
  removed.push(".git/info/exclude managed scaffold block");
  return removed;
}

export async function detectMonorepoPackages(repoRoot: string): Promise<string[]> {
  return listPackages(repoRoot);
}
