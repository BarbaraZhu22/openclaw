import { handleAcpSpawnAction, handleAcpSteerAction } from "./commands-acp/lifecycle.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { listAcpSessionEntries } from "../../acp/runtime/session-meta.js";
import { loadSessionStore, resolveAllAgentSessionStoreTargets } from "../../config/sessions.js";
import {
  DISCORD_THREAD_BINDING_CHANNEL,
  MATRIX_THREAD_BINDING_CHANNEL,
} from "../../channels/thread-bindings-policy.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";

const COMMAND = "/cursor-start";
const STOP_COMMAND = "/cursor-stop";
const SANDBOX_COMMAND = "/sandbox-start";
const CURSORX_BACKEND_ID = "cursorx";
const CURSORX_SLOT_LABEL_PREFIX = "cursorx-";
const CURSORX_LEGACY_LABEL = "cursorx-start";
const DEFAULT_HARNESS_ID = "codex";
const DEFAULT_CURSORX_MAX_SESSIONS = 5;
const START_USAGE = [
  "Usage:",
  "/cursor-start start",
  "/cursor-start start repoId=<id> intent=\"<task>\"",
  "/cursor-start <wizard-reply>",
].join("\n");
const STOP_USAGE = ["Usage:", "/cursor-stop all"].join("\n");

function rewriteSandboxWizardText(text: string): string {
  return text.replaceAll("/sandbox-start", COMMAND);
}

function stopWithText(text: string) {
  return {
    shouldContinue: false as const,
    reply: { text },
  };
}

function parseCursorxStartArgs(
  commandBody: string,
  allowContinuation: boolean,
): { ok: true; translatedBody: string } | { ok: false } {
  if (commandBody.startsWith(COMMAND)) {
    const rest = commandBody.slice(COMMAND.length).trim();
    if (!rest) {
      return { ok: true, translatedBody: SANDBOX_COMMAND };
    }
    const tokens = rest.split(/\s+/).filter(Boolean);
    if (tokens[0]?.toLowerCase() === "help") {
      return { ok: true, translatedBody: "" };
    }
    const translatedArgs =
      tokens[0]?.toLowerCase() === "start" ? rest.slice(tokens[0].length).trim() : rest;
    return {
      ok: true,
      translatedBody: translatedArgs ? `${SANDBOX_COMMAND} ${translatedArgs}` : SANDBOX_COMMAND,
    };
  }
  if (!allowContinuation) {
    return { ok: false };
  }
  const followup = commandBody.trim();
  if (!followup || followup.startsWith("/")) {
    return { ok: false };
  }
  return {
    ok: true,
    translatedBody: `${SANDBOX_COMMAND} ${followup}`,
  };
}

function parseSandboxWorkspace(resultText: string): string | null {
  const match = resultText.match(/(?:^|\n)START_AI_PROJECT_WORKSPACE=([^\n\r]+)/);
  return match?.[1]?.trim() || null;
}

function parseSpawnedAcpSessionKey(text: string): string | null {
  const match = text.match(/\bagent:[a-z0-9_-]+:acp:[0-9a-f-]{36}\b/i);
  return match?.[0] ?? null;
}

function resolveCursorxMaxSessions(params: Parameters<CommandHandler>[0]): number {
  const raw = params.cfg.plugins?.entries?.cursorx?.config?.maxSessions;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return DEFAULT_CURSORX_MAX_SESSIONS;
  }
  return Math.max(1, Math.floor(raw));
}

async function listCursorxAcpSessions(
  params: Parameters<CommandHandler>[0],
): Promise<Array<{ sessionKey: string; updatedAt: number; label?: string; storePath: string }>> {
  const entries = await listAcpSessionEntries({ cfg: params.cfg });
  return entries
    .filter((entry) => entry.acp?.backend?.trim().toLowerCase() === CURSORX_BACKEND_ID)
    .map((entry) => ({
      sessionKey: entry.sessionKey,
      updatedAt: entry.entry?.updatedAt ?? 0,
      label: entry.entry?.label?.trim() || undefined,
      storePath: entry.storePath,
    }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
}

async function listLegacyCursorxLabelSessions(
  params: Parameters<CommandHandler>[0],
): Promise<Array<{ sessionKey: string; updatedAt: number; label: string; storePath: string }>> {
  const storeTargets = await resolveAllAgentSessionStoreTargets(params.cfg);
  const rows: Array<{ sessionKey: string; updatedAt: number; label: string; storePath: string }> = [];
  for (const target of storeTargets) {
    let store: Record<string, { label?: unknown; updatedAt?: unknown; acp?: { backend?: unknown } }>;
    try {
      store = loadSessionStore(target.storePath);
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      if (label !== CURSORX_LEGACY_LABEL) {
        continue;
      }
      const backend = typeof entry?.acp?.backend === "string" ? entry.acp.backend.trim() : "";
      if (backend.toLowerCase() === CURSORX_BACKEND_ID) {
        continue;
      }
      rows.push({
        sessionKey,
        updatedAt: typeof entry?.updatedAt === "number" ? entry.updatedAt : 0,
        label,
        storePath: target.storePath,
      });
    }
  }
  return rows;
}

function resolveCursorxSlotLabel(
  sessions: Array<{ label?: string }>,
  maxSessions: number,
): string | null {
  const used = new Set(
    sessions.map((session) => session.label?.trim().toLowerCase()).filter((value): value is string =>
      Boolean(value),
    ),
  );
  for (let slot = 1; slot <= maxSessions; slot += 1) {
    const candidate = `${CURSORX_SLOT_LABEL_PREFIX}${slot}`;
    if (!used.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return null;
}

async function cleanupOrphanedCursorxAcpSessions(
  params: Parameters<CommandHandler>[0],
  sessions: Array<{ sessionKey: string; updatedAt: number; label?: string; storePath: string }>,
): Promise<Array<{ sessionKey: string; updatedAt: number; label?: string; storePath: string }>> {
  if (sessions.length === 0) {
    return sessions;
  }
  const acpManager = getAcpSessionManager();
  const bindingService = getSessionBindingService();
  const remaining: Array<{ sessionKey: string; updatedAt: number }> = [];
  for (const session of sessions) {
    const bindings = bindingService.listBySession(session.sessionKey);
    if (bindings.length > 0) {
      remaining.push(session);
      continue;
    }
    try {
      await acpManager.closeSession({
        cfg: params.cfg,
        sessionKey: session.sessionKey,
        reason: "manual-close",
        allowBackendUnavailable: true,
        clearMeta: true,
      });
      await bindingService.unbind({
        targetSessionKey: session.sessionKey,
        reason: "manual",
      });
    } catch {
      // Keep failed cleanup candidates in the count so we do not hide limit pressure.
      remaining.push(session);
    }
  }
  return remaining;
}

async function clearLegacyCursorxLabel(params: {
  storePath: string;
  sessionKey: string;
}): Promise<boolean> {
  return Boolean(
    await updateSessionStore(params.storePath, (store) => {
      const current = store[params.sessionKey];
      if (!current || current.label !== CURSORX_LEGACY_LABEL) {
        return false;
      }
      store[params.sessionKey] = { ...current, label: undefined };
      return true;
    }),
  );
}

async function handleCursorStopAll(params: Parameters<CommandHandler>[0]) {
  const cursorxSessions = await listCursorxAcpSessions(params);
  const legacyLabelSessions = await listLegacyCursorxLabelSessions(params);
  if (cursorxSessions.length === 0 && legacyLabelSessions.length === 0) {
    return stopWithText("ℹ️ No Cursor ACP sessions are active.");
  }
  const acpManager = getAcpSessionManager();
  const bindingService = getSessionBindingService();
  const cursorxSessionKeys = new Set(cursorxSessions.map((session) => session.sessionKey));
  const sessions = [
    ...cursorxSessions.map((session) => ({ ...session, legacyOnly: false as const })),
    ...legacyLabelSessions
      .filter((session) => !cursorxSessionKeys.has(session.sessionKey))
      .map((session) => ({ ...session, legacyOnly: true as const })),
  ];
  let closed = 0;
  let legacyCleared = 0;
  let failed = 0;
  let removedBindings = 0;
  const failures: string[] = [];
  for (const session of sessions) {
    try {
      if (session.legacyOnly) {
        const cleared = await clearLegacyCursorxLabel({
          storePath: session.storePath,
          sessionKey: session.sessionKey,
        });
        const unbound = await bindingService.unbind({
          targetSessionKey: session.sessionKey,
          reason: "manual",
        });
        removedBindings += unbound.length;
        if (cleared) {
          legacyCleared += 1;
        }
      } else {
        await acpManager.closeSession({
          cfg: params.cfg,
          sessionKey: session.sessionKey,
          reason: "manual-close",
          allowBackendUnavailable: true,
          clearMeta: true,
        });
        const unbound = await bindingService.unbind({
          targetSessionKey: session.sessionKey,
          reason: "manual",
        });
        removedBindings += unbound.length;
        closed += 1;
      }
    } catch (error) {
      failed += 1;
      if (failures.length < 3) {
        failures.push(`- ${session.sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  const parts = [
    `✅ Closed ${closed}/${cursorxSessions.length} Cursor ACP session${cursorxSessions.length === 1 ? "" : "s"}.`,
    `Cleared ${legacyCleared}/${legacyLabelSessions.length} legacy cursorx-start label${legacyLabelSessions.length === 1 ? "" : "s"}.`,
    `Removed ${removedBindings} binding${removedBindings === 1 ? "" : "s"}.`,
  ];
  if (failed > 0) {
    parts.push(`⚠️ Failed to close ${failed} session${failed === 1 ? "" : "s"}.`);
    if (failures.length > 0) {
      parts.push(["Examples:", ...failures].join("\n"));
    }
  }
  return stopWithText(parts.join("\n"));
}

function resolveCursorStartSpawnThreadMode(
  params: Parameters<CommandHandler>[0],
): "off" | "here" | "auto" {
  const channel = String(
    params.ctx.OriginatingChannel ??
      params.command.channel ??
      params.ctx.Surface ??
      params.ctx.Provider ??
      "",
  )
    .trim()
    .toLowerCase();
  if (channel !== DISCORD_THREAD_BINDING_CHANNEL && channel !== MATRIX_THREAD_BINDING_CHANNEL) {
    return "off";
  }
  const threadId =
    params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
  return threadId ? "here" : "auto";
}

async function setCursorStartPendingState(params: Parameters<CommandHandler>[0], pending: boolean) {
  if (!params.sessionStore) {
    return;
  }
  const currentEntry = params.sessionStore[params.sessionKey] ?? params.sessionEntry;
  if (!currentEntry) {
    return;
  }
  const updatedEntry = pending
    ? { ...currentEntry, cursorStartPending: true }
    : { ...currentEntry, cursorStartPending: undefined };
  params.sessionStore[params.sessionKey] = updatedEntry;
  if (params.sessionEntry) {
    Object.assign(params.sessionEntry, updatedEntry);
  }
  if (!params.storePath) {
    return;
  }
  await updateSessionStore(params.storePath, (store) => {
    const persisted = store[params.sessionKey] ?? currentEntry;
    store[params.sessionKey] = pending
      ? { ...persisted, cursorStartPending: true }
      : { ...persisted, cursorStartPending: undefined };
  });
}

export const handleCursorxCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBody = params.command.commandBodyNormalized.trim();
  if (commandBody.startsWith(STOP_COMMAND)) {
    const rest = commandBody.slice(STOP_COMMAND.length).trim().toLowerCase();
    if (!rest || rest === "help") {
      return stopWithText(STOP_USAGE);
    }
    if (rest !== "all") {
      return stopWithText(STOP_USAGE);
    }
    const unauthorized = rejectUnauthorizedCommand(params, STOP_COMMAND);
    if (unauthorized) {
      return unauthorized;
    }
    return await handleCursorStopAll(params);
  }
  const hasPendingWizard = params.sessionEntry?.cursorStartPending === true;
  const parsed = parseCursorxStartArgs(commandBody, hasPendingWizard);
  if (!parsed.ok) {
    return null;
  }
  if (!parsed.translatedBody) {
    return stopWithText(START_USAGE);
  }

  const unauthorized = rejectUnauthorizedCommand(params, COMMAND);
  if (unauthorized) {
    return unauthorized;
  }

  const match = matchPluginCommand(parsed.translatedBody);
  if (!match || match.command.name !== "sandbox-start") {
    await setCursorStartPendingState(params, false);
    return stopWithText(
      "⚠️ /cursor-start start requires the start-ai-project plugin command `/sandbox-start`, but it is unavailable.",
    );
  }

  const sandboxResult = await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: params.command.senderId,
    channel: params.command.channel,
    channelId: params.command.channelId,
    isAuthorizedSender: params.command.isAuthorizedSender,
    gatewayClientScopes: params.ctx.GatewayClientScopes,
    commandBody: parsed.translatedBody,
    config: params.cfg,
    from: params.command.from,
    to: params.command.to,
    accountId: params.ctx.AccountId ?? undefined,
    messageThreadId:
      typeof params.ctx.MessageThreadId === "string" || typeof params.ctx.MessageThreadId === "number"
        ? params.ctx.MessageThreadId
        : undefined,
  });

  const sandboxText =
    typeof sandboxResult.text === "string" ? rewriteSandboxWizardText(sandboxResult.text) : "";
  if (!sandboxText.includes("Sandbox ready.")) {
    await setCursorStartPendingState(params, true);
    return {
      shouldContinue: false,
      reply: {
        ...sandboxResult,
        ...(typeof sandboxResult.text === "string" ? { text: sandboxText } : {}),
      },
    };
  }
  await setCursorStartPendingState(params, false);

  const workspacePath = parseSandboxWorkspace(sandboxText);
  if (!workspacePath) {
    const threadMode = resolveCursorStartSpawnThreadMode(params);
    return {
      shouldContinue: false,
      reply: {
        text:
          `${sandboxText}\n\n` +
          "⚠️ Could not parse sandbox workspace path for ACP handoff. " +
          `Run: /acp spawn ${params.cfg.acp?.defaultAgent?.trim() || DEFAULT_HARNESS_ID} --thread ${threadMode}`,
      },
    };
  }

  const harnessId = params.cfg.acp?.defaultAgent?.trim() || DEFAULT_HARNESS_ID;
  const threadMode = resolveCursorStartSpawnThreadMode(params);
  const maxSessions = resolveCursorxMaxSessions(params);
  const cursorxSessionsBeforeCleanup = await listCursorxAcpSessions(params);
  const cursorxSessions = await cleanupOrphanedCursorxAcpSessions(
    params,
    cursorxSessionsBeforeCleanup,
  );
  const spawnLabel = resolveCursorxSlotLabel(cursorxSessions, maxSessions);
  if (!spawnLabel) {
    return stopWithText(
      `${sandboxText}\n\n` +
        `⚠️ Cursor ACP session limit reached (${cursorxSessions.length}/${maxSessions}). ` +
        "Run /cursor-stop all to close existing Cursor sessions.",
    );
  }
  if (cursorxSessions.length >= maxSessions) {
    return stopWithText(
      `${sandboxText}\n\n` +
        `⚠️ Cursor ACP session limit reached (${cursorxSessions.length}/${maxSessions}). ` +
        "Run /cursor-stop all to close existing Cursor sessions.",
    );
  }
  const spawnTokens = [
    harnessId,
    "--mode",
    "persistent",
    "--thread",
    threadMode,
    "--cwd",
    workspacePath,
    "--label",
    spawnLabel,
  ];
  const cursorxSpawnParams = {
    ...params,
    cfg: {
      ...params.cfg,
      acp: {
        ...params.cfg.acp,
        backend: "cursorx",
      },
    },
  };
  const spawnResult = await handleAcpSpawnAction(cursorxSpawnParams, spawnTokens);
  const spawnText = spawnResult.reply?.text ?? "";
  const sessionKey = parseSpawnedAcpSessionKey(spawnText);
  if (!sessionKey) {
    return {
      shouldContinue: false,
      reply: {
        text:
          `${sandboxText}\n\n` +
          (spawnText || "⚠️ ACP spawn did not return a session key.") +
          "\n\nIf needed, run /acp spawn manually using the sandbox workspace path above.",
      },
    };
  }

  const steerResult = await handleAcpSteerAction(params, ["--session", sessionKey, "APB"]);
  const steerText = steerResult.reply?.text ?? `✅ APB trigger sent to ${sessionKey}.`;
  return {
    shouldContinue: false,
    reply: {
      text: `${sandboxText}\n\n${spawnText}\n\n${steerText}`,
    },
  };
};
