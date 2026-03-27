import type { PluginCommandContext } from "../runtime-api.js";
import type { RepoDescriptor, SandboxMode } from "./types.js";

type WizardStep = "choose_repo" | "choose_package" | "enter_intent" | "confirm";

export type WizardSession = {
  key: string;
  step: WizardStep;
  visibleRepos: RepoDescriptor[];
  selectedRepoId?: string;
  packageOptions: string[];
  targetPackage?: string;
  intent?: string;
  baseBranch?: string;
  installDeps: boolean;
  openCursor: boolean;
  mode: SandboxMode;
  updatedAt: number;
};

const WIZARD_TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, WizardSession>();

export function createWizardSession(
  ctx: PluginCommandContext,
  visibleRepos: RepoDescriptor[],
): WizardSession {
  return {
    key: getWizardSessionKey(ctx),
    step: "choose_repo",
    visibleRepos,
    packageOptions: [],
    installDeps: false,
    openCursor: false,
    mode: "copy",
    updatedAt: Date.now(),
  };
}

export function getWizardSessionKey(ctx: PluginCommandContext): string {
  const channel = ctx.channel || "unknown";
  const accountId = ctx.accountId || "default";
  const conversation = ctx.to || ctx.from || "unknown";
  const senderId = ctx.senderId || "unknown";
  return [channel, accountId, conversation, senderId].join("::");
}

export function getWizardSession(ctx: PluginCommandContext): WizardSession | undefined {
  pruneExpiredSessions();
  const session = sessions.get(getWizardSessionKey(ctx));
  if (!session) {
    return undefined;
  }
  session.updatedAt = Date.now();
  return session;
}

export function saveWizardSession(session: WizardSession): void {
  session.updatedAt = Date.now();
  sessions.set(session.key, session);
}

export function clearWizardSession(ctx: PluginCommandContext): void {
  sessions.delete(getWizardSessionKey(ctx));
}

export function isWizardCancelInput(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "cancel" || normalized === "quit" || normalized === "exit";
}

export function isWizardConfirmInput(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return normalized === "go" || normalized === "yes" || normalized === "start" || normalized === "create";
}

export function resolveRepoChoice(input: string, repos: RepoDescriptor[]): RepoDescriptor | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const index = Number.parseInt(trimmed, 10);
  if (Number.isInteger(index) && index >= 1 && index <= repos.length) {
    return repos[index - 1];
  }
  const normalized = trimmed.toLowerCase();
  return repos.find((repo) => {
    const label = repo.label?.trim().toLowerCase();
    return repo.id.toLowerCase() === normalized || (label ? label === normalized : false);
  });
}

export function resolvePackageChoice(
  input: string,
  packageOptions: string[],
): { ok: true; targetPackage?: string } | { ok: false } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false };
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "0" || normalized === "repo" || normalized === "all" || normalized === "entire") {
    return { ok: true, targetPackage: undefined };
  }
  const index = Number.parseInt(trimmed, 10);
  if (Number.isInteger(index) && index >= 1 && index <= packageOptions.length) {
    return { ok: true, targetPackage: packageOptions[index - 1] };
  }
  const matched = packageOptions.find((pkg) => pkg.toLowerCase() === normalized);
  return matched ? { ok: true, targetPackage: matched } : { ok: false };
}

export function formatRepoListPrompt(params: {
  repos: RepoDescriptor[];
  isGroup: boolean;
  groupId?: string;
}): string {
  const lines = params.repos.map((repo, index) => {
    const label = repo.label?.trim() || repo.id;
    return `${index + 1}. ${label} (${repo.id})`;
  });
  const contextLine =
    params.isGroup && params.groupId
      ? `Visible repositories for this group (${params.groupId}):`
      : "Choose a repository:";
  return [
    "Sandbox setup wizard.",
    contextLine,
    ...lines,
    "",
    'Reply with `/sandbox-start 1`, `/sandbox-start <repoId>`, or `/sandbox-start cancel`.',
  ].join("\n");
}

export function formatNoVisibleReposText(params: { isGroup: boolean; groupId?: string }): string {
  if (params.isGroup) {
    return [
      "No repositories are available in this group.",
      params.groupId ? `- groupId: ${params.groupId}` : "",
      "Ask an admin to add this group to start-ai-project.groupRepoFilters.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    "No repositories configured.",
    "Set start-ai-project.repoListPath in plugin config, then run /sandbox-start again.",
  ].join("\n");
}

export function formatPackagePrompt(params: { repo: RepoDescriptor; packageOptions: string[] }): string {
  const repoLabel = params.repo.label?.trim() || params.repo.id;
  const lines = [
    `Repository selected: ${repoLabel} (${params.repo.id})`,
    "",
    "Choose a target:",
    "0. entire repo",
    ...params.packageOptions.map((pkg, index) => `${index + 1}. ${pkg}`),
    "",
    'Reply with `/sandbox-start 0`, `/sandbox-start 1`, `/sandbox-start <package>`, or `/sandbox-start cancel`.',
  ];
  return lines.join("\n");
}

export function formatIntentPrompt(params: { repo: RepoDescriptor; targetPackage?: string }): string {
  const repoLabel = params.repo.label?.trim() || params.repo.id;
  return [
    `Repository selected: ${repoLabel} (${params.repo.id})`,
    `Target: ${params.targetPackage || "entire repo"}`,
    "",
    "What should the sandbox work on?",
    'Reply with `/sandbox-start <your task>`.',
    'Example: `/sandbox-start implement login page`',
  ].join("\n");
}

export function formatConfirmPrompt(params: {
  repo: RepoDescriptor;
  targetPackage?: string;
  intent: string;
  baseBranch?: string;
  installDeps: boolean;
  openCursor: boolean;
  mode: SandboxMode;
}): string {
  const repoLabel = params.repo.label?.trim() || params.repo.id;
  return [
    "Ready to create sandbox:",
    `- repo: ${repoLabel} (${params.repo.id})`,
    `- target: ${params.targetPackage || "entire repo"}`,
    `- intent: ${params.intent}`,
    `- baseBranch: ${params.baseBranch || "(auto)"}`,
    `- mode: ${params.mode}`,
    `- installDeps: ${String(params.installDeps)}`,
    `- openCursor: ${String(params.openCursor)}`,
    "",
    'Reply with `/sandbox-start go` to create it or `/sandbox-start cancel`.',
  ].join("\n");
}

export function formatWizardStartHint(): string {
  return [
    "No sandbox wizard is active.",
    'Send `/sandbox-start` to begin.',
    'Advanced mode still works: `/sandbox-start repoId=<id> intent="..."`',
  ].join("\n");
}

function pruneExpiredSessions(): void {
  const cutoff = Date.now() - WIZARD_TTL_MS;
  for (const [key, session] of sessions.entries()) {
    if (session.updatedAt < cutoff) {
      sessions.delete(key);
    }
  }
}
