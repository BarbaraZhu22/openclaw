import crypto from "node:crypto";
import { handleAcpSpawnAction, handleAcpSteerAction } from "./commands-acp/lifecycle.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { getAcpSessionManager } from "../../acp/control-plane/manager.js";
import { listAcpSessionEntries } from "../../acp/runtime/session-meta.js";
import { loadSessionStore, resolveAllAgentSessionStoreTargets } from "../../config/sessions.js";
import { resolveSessionStoreEntry, updateSessionStore } from "../../config/sessions/store.js";
import type { CursorxSlotId, CursorxSlotState, CursorxSlots, SessionEntry } from "../../config/sessions/types.js";
import { callGateway } from "../../gateway/call.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";

const COMMAND = "/cursor-start";
const STOP_COMMAND = "/cursor-stop";
const STOP_ALL_COMMAND = "/cursor-all";
const SANDBOX_COMMAND = "/sandbox-start";
const CURSORX_BACKEND_ID = "cursorx";
const CURSORX_SLOT_LABEL_PREFIX = "cursorx-";
const CURSORX_LEGACY_LABEL = "cursorx-start";
const DEFAULT_HARNESS_ID = "codex";
const DEFAULT_CURSORX_MAX_SESSIONS = 5;
const CURSOR_SLOT_IDS: CursorxSlotId[] = ["cursor1", "cursor2", "cursor3", "cursor4", "cursor5"];
const GROUP_MISSING_PROJECT_GUIDANCE = "Please use /cursor-start to start a project first.";

const START_USAGE = [
  "Usage:",
  "/cursor-start",
  "/cursor-start start repoId=<id> intent=\"<task>\"",
  "/cursor1 <message>",
  "/cursor1 stop",
  "/cursor-all stop",
].join("\n");
const STOP_USAGE = ["Usage:", "/cursor-stop all", "/cursor-stop cursor1", "/cursor1 stop"].join("\n");
const CURSOR_ALL_USAGE = ["Usage:", "/cursor-all stop"].join("\n");

function stopWithText(text: string) {
  return { shouldContinue: false as const, reply: { text } };
}

function rewriteSandboxWizardTextForSlot(text: string, slotId: CursorxSlotId): string {
  return text.replaceAll("/sandbox-start", `/${slotId}`).replaceAll(COMMAND, `/${slotId}`);
}

function parseCommandPrefix(commandBody: string, command: string): string | null {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = commandBody.match(new RegExp(`^${escaped}(?:\\b|$)`, "i"));
  if (!match) {
    return null;
  }
  return commandBody.slice(match[0].length).trim();
}

function parseCursorxStartArgs(commandBody: string): { ok: true; translatedBody: string } | { ok: false } {
  const rest = parseCommandPrefix(commandBody, COMMAND);
  if (rest === null) {
    return { ok: false };
  }
  if (!rest) {
    return { ok: true, translatedBody: SANDBOX_COMMAND };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() === "help") {
    return { ok: true, translatedBody: "" };
  }
  const translatedArgs = tokens[0]?.toLowerCase() === "start" ? rest.slice(tokens[0].length).trim() : rest;
  return { ok: true, translatedBody: translatedArgs ? `${SANDBOX_COMMAND} ${translatedArgs}` : SANDBOX_COMMAND };
}

function parseSandboxWorkspace(resultText: string): string | null {
  return resultText.match(/(?:^|\n)START_AI_PROJECT_WORKSPACE=([^\n\r]+)/)?.[1]?.trim() || null;
}

function parseSandboxIntent(resultText: string): string | undefined {
  const raw = resultText.match(/(?:^|\n)START_AI_PROJECT_META=([^\n\r]+)/)?.[1];
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed?.intent === "string" && parsed.intent.trim() ? parsed.intent.trim() : undefined;
  } catch {
    return undefined;
  }
}

function parseCursorSlotCommand(commandBody: string): { slotId: CursorxSlotId; rest: string } | null {
  const match = commandBody.match(/^\/(cursor[1-5])(?:\s+([\s\S]*))?$/i);
  if (!match) {
    return null;
  }
  const slotId = match[1]?.toLowerCase() as CursorxSlotId;
  if (!CURSOR_SLOT_IDS.includes(slotId)) {
    return null;
  }
  return { slotId, rest: match[2]?.trim() ?? "" };
}

function isCursorControlCommand(commandBody: string): boolean {
  return /^\/cursor(?:-start|-stop|-all|[1-5])\b/i.test(commandBody.trim());
}

function isFeishuGroupChat(params: Parameters<CommandHandler>[0]): boolean {
  if (!params.isGroup) {
    return false;
  }
  const channel = params.command.channel?.trim().toLowerCase();
  const provider = params.ctx.Provider?.trim().toLowerCase();
  const surface = params.ctx.Surface?.trim().toLowerCase();
  return channel === "feishu" || provider === "feishu" || surface === "feishu";
}

function resolveCursorxMaxSessions(params: Parameters<CommandHandler>[0]): number {
  const raw = params.cfg.plugins?.entries?.cursorx?.config?.maxSessions;
  return typeof raw === "number" && Number.isFinite(raw) ? Math.max(1, Math.floor(raw)) : DEFAULT_CURSORX_MAX_SESSIONS;
}

function resolveEnabledSlotIds(params: Parameters<CommandHandler>[0]): CursorxSlotId[] {
  const maxSessions = Math.max(1, Math.min(CURSOR_SLOT_IDS.length, resolveCursorxMaxSessions(params)));
  return CURSOR_SLOT_IDS.slice(0, maxSessions);
}

function cloneSlots(slots?: CursorxSlots): CursorxSlots {
  return slots ? { ...slots } : {};
}

function resolveWorkerId(): string {
  const raw =
    process.env.OPENCLAW_POOL_WORKER_ID ??
    process.env.OPENCLAW_WORKER_ID ??
    process.env.VITEST_WORKER_ID ??
    String(process.pid);
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "worker";
}

function buildCursorxSessionKey(params: { agentId: string; hostSessionKey: string; slotId: CursorxSlotId }): string {
  const hostHash = crypto.createHash("sha1").update(params.hostSessionKey).digest("hex").slice(0, 10);
  return `agent:${params.agentId}:acp:cursor-${params.slotId}-${resolveWorkerId()}-${hostHash}-${Date.now().toString(36)}`;
}

function resolveSlotLabel(slotId: CursorxSlotId): string {
  return `${CURSORX_SLOT_LABEL_PREFIX}${Number(slotId.slice("cursor".length))}`;
}

function isCursorxSlotLabel(label: string): boolean {
  if (!label.startsWith(CURSORX_SLOT_LABEL_PREFIX)) {
    return false;
  }
  const suffix = label.slice(CURSORX_SLOT_LABEL_PREFIX.length);
  return /^[1-9]\d*$/.test(suffix);
}

function isCursorxSlotOccupied(slot?: CursorxSlotState): boolean {
  return Boolean(slot && (slot.acpSessionKey?.trim() || slot.wizardPending));
}

function syncHostEntryInMemory(params: Parameters<CommandHandler>[0], entry: SessionEntry) {
  if (params.sessionStore) {
    params.sessionStore[params.sessionKey] = entry;
  }
  if (params.sessionEntry) {
    Object.assign(params.sessionEntry, entry);
  }
}

async function updateHostEntry(
  params: Parameters<CommandHandler>[0],
  mutate: (entry: SessionEntry) => { next: SessionEntry; result: unknown } | null,
): Promise<unknown> {
  const fallbackEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  if (!fallbackEntry) {
    return null;
  }

  if (!params.storePath) {
    const mutated = mutate(fallbackEntry);
    if (!mutated) {
      return null;
    }
    syncHostEntryInMemory(params, mutated.next);
    return mutated.result;
  }

  let output: unknown = null;
  await updateSessionStore(params.storePath, (store) => {
    const resolved = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey });
    const mutated = mutate(resolved.existing ?? fallbackEntry);
    if (!mutated) {
      return false;
    }
    store[resolved.normalizedKey] = mutated.next;
    output = mutated.result;
    syncHostEntryInMemory(params, mutated.next);
    return true;
  });
  return output;
}

async function reserveNextCursorSlot(params: Parameters<CommandHandler>[0]): Promise<{ slotId: CursorxSlotId } | null> {
  const slotIds = resolveEnabledSlotIds(params);
  const result = await updateHostEntry(params, (entry) => {
    const slots = cloneSlots(entry.cursorxSlots);
    const slotId = slotIds.find((id) => !isCursorxSlotOccupied(slots[id]));
    if (!slotId) {
      return null;
    }
    slots[slotId] = { ...slots[slotId], wizardPending: true, updatedAt: Date.now() };
    return { next: { ...entry, cursorxSlots: slots, cursorStartPending: true }, result: { slotId } };
  });
  return (result as { slotId: CursorxSlotId } | null) ?? null;
}

async function updateCursorSlot(
  params: Parameters<CommandHandler>[0],
  slotId: CursorxSlotId,
  updater: (slot: CursorxSlotState | undefined) => CursorxSlotState | undefined,
) {
  await updateHostEntry(params, (entry) => {
    const slots = cloneSlots(entry.cursorxSlots);
    const nextSlot = updater(slots[slotId]);
    if (nextSlot) {
      slots[slotId] = nextSlot;
    } else {
      delete slots[slotId];
    }
    const stillPending = Object.values(slots).some((slot) => slot?.wizardPending === true);
    return {
      next: {
        ...entry,
        cursorxSlots: Object.keys(slots).length > 0 ? slots : undefined,
        cursorStartPending: stillPending ? true : undefined,
      },
      result: null,
    };
  });
}

function getCursorSlot(params: Parameters<CommandHandler>[0], slotId: CursorxSlotId): CursorxSlotState | undefined {
  return (params.sessionStore?.[params.sessionKey] ?? params.sessionEntry)?.cursorxSlots?.[slotId];
}

function resolveMissingSlotGuidance(params: Parameters<CommandHandler>[0], slotId: CursorxSlotId): string {
  if (params.isGroup) {
    return GROUP_MISSING_PROJECT_GUIDANCE;
  }
  return `${slotId} is not allocated. Start one with ${COMMAND}.`;
}

function resolveGroupFlowGuidanceForNonCursorInput(
  params: Parameters<CommandHandler>[0],
  commandBody: string,
): string | null {
  if (!isFeishuGroupChat(params) || isCursorControlCommand(commandBody)) {
    return null;
  }
  const hostEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const slots = hostEntry?.cursorxSlots;
  if (!slots || Object.keys(slots).length === 0) {
    return GROUP_MISSING_PROJECT_GUIDANCE;
  }
  const pendingSlotId = resolveEnabledSlotIds(params).find((slotId) => slots[slotId]?.wizardPending === true);
  if (pendingSlotId) {
    return `Please use /${pendingSlotId} ... to continue this project.`;
  }
  return "Please use /cursorN ... to continue this project.";
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
      const backend = typeof entry?.acp?.backend === "string" ? entry.acp.backend.trim() : "";
      if (label !== CURSORX_LEGACY_LABEL || backend.toLowerCase() === CURSORX_BACKEND_ID) {
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

async function listGhostCursorxLabelEntries(
  params: Parameters<CommandHandler>[0],
): Promise<Array<{ sessionKey: string; updatedAt: number; label: string; storePath: string }>> {
  const storeTargets = await resolveAllAgentSessionStoreTargets(params.cfg);
  const rows: Array<{ sessionKey: string; updatedAt: number; label: string; storePath: string }> = [];
  for (const target of storeTargets) {
    let store: Record<string, { label?: unknown; updatedAt?: unknown; acp?: unknown }>;
    try {
      store = loadSessionStore(target.storePath);
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      const label = typeof entry?.label === "string" ? entry.label.trim() : "";
      if (!isCursorxSlotLabel(label) || entry?.acp) {
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

async function clearSessionLabelViaGateway(params: Parameters<CommandHandler>[0], sessionKey: string): Promise<boolean> {
  const key = sessionKey.trim();
  if (!key) {
    return false;
  }
  try {
    await callGateway({
      method: "sessions.patch",
      params: { key, label: null },
      timeoutMs: 5_000,
      config: params.cfg,
    });
    return true;
  } catch {
    return false;
  }
}

async function clearGhostLabelIfExists(
  params: Parameters<CommandHandler>[0],
  label: string,
): Promise<{ cleared: number; failed: number }> {
  const targetLabel = label.trim();
  if (!targetLabel) {
    return { cleared: 0, failed: 0 };
  }
  const ghosts = (await listGhostCursorxLabelEntries(params)).filter((entry) => entry.label === targetLabel);
  if (ghosts.length === 0) {
    return { cleared: 0, failed: 0 };
  }
  let cleared = 0;
  let failed = 0;
  for (const ghost of ghosts) {
    if (await clearSessionLabelViaGateway(params, ghost.sessionKey)) {
      cleared += 1;
    } else {
      failed += 1;
    }
  }
  return { cleared, failed };
}

async function collectReferencedCursorxSessionKeys(params: Parameters<CommandHandler>[0]): Promise<Set<string>> {
  const keys = new Set<string>();
  const storeTargets = await resolveAllAgentSessionStoreTargets(params.cfg);
  for (const target of storeTargets) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(target.storePath);
    } catch {
      continue;
    }
    for (const entry of Object.values(store)) {
      for (const slot of Object.values(entry?.cursorxSlots ?? {})) {
        const key = slot?.acpSessionKey?.trim();
        if (key) {
          keys.add(key);
        }
      }
    }
  }
  return keys;
}

async function cleanupOrphanedCursorxAcpSessions(
  params: Parameters<CommandHandler>[0],
  sessions: Array<{ sessionKey: string; updatedAt: number; label?: string; storePath: string }>,
) {
  if (sessions.length === 0) {
    return sessions;
  }
  const acpManager = getAcpSessionManager();
  const bindingService = getSessionBindingService();
  const referencedSessionKeys = await collectReferencedCursorxSessionKeys(params);
  const remaining: Array<{ sessionKey: string; updatedAt: number }> = [];
  for (const session of sessions) {
    if (referencedSessionKeys.has(session.sessionKey)) {
      remaining.push(session);
      continue;
    }
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
      await bindingService.unbind({ targetSessionKey: session.sessionKey, reason: "manual" });
    } catch {
      remaining.push(session);
    }
  }
  return remaining;
}

async function clearLegacyCursorxLabel(params: { storePath: string; sessionKey: string }): Promise<boolean> {
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

async function clearCursorSlotPointers(params: Parameters<CommandHandler>[0], sessionKeys: Iterable<string>): Promise<number> {
  const targetKeys = new Set(Array.from(sessionKeys).map((key) => key.trim()).filter(Boolean));
  if (targetKeys.size === 0) {
    return 0;
  }
  const storeTargets = await resolveAllAgentSessionStoreTargets(params.cfg);
  let cleared = 0;
  for (const target of storeTargets) {
    await updateSessionStore(target.storePath, (store) => {
      let changed = false;
      for (const [sessionKey, entry] of Object.entries(store)) {
        const slots = entry?.cursorxSlots;
        if (!slots) {
          continue;
        }
        const nextSlots: CursorxSlots = { ...slots };
        let slotChanged = false;
        for (const slotId of CURSOR_SLOT_IDS) {
          const key = nextSlots[slotId]?.acpSessionKey?.trim();
          if (!key || !targetKeys.has(key)) {
            continue;
          }
          delete nextSlots[slotId];
          slotChanged = true;
          cleared += 1;
        }
        if (!slotChanged) {
          continue;
        }
        const stillPending = Object.values(nextSlots).some((slot) => slot?.wizardPending === true);
        store[sessionKey] = {
          ...entry,
          cursorxSlots: Object.keys(nextSlots).length > 0 ? nextSlots : undefined,
          cursorStartPending: stillPending ? true : undefined,
        };
        changed = true;
      }
      return changed;
    });
  }
  return cleared;
}

async function handleCursorStopAll(params: Parameters<CommandHandler>[0]) {
  const cursorxSessions = await listCursorxAcpSessions(params);
  const legacyLabelSessions = await listLegacyCursorxLabelSessions(params);
  const ghostLabelSessions = await listGhostCursorxLabelEntries(params);
  if (cursorxSessions.length === 0 && legacyLabelSessions.length === 0 && ghostLabelSessions.length === 0) {
    return stopWithText("No Cursor ACP sessions are active.");
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
  let closedLabelCleared = 0;
  let failed = 0;
  let removedBindings = 0;
  const clearedSessionKeys: string[] = [];
  const failures: string[] = [];
  for (const session of sessions) {
    try {
      if (session.legacyOnly) {
        const cleared = await clearLegacyCursorxLabel({ storePath: session.storePath, sessionKey: session.sessionKey });
        const unbound = await bindingService.unbind({ targetSessionKey: session.sessionKey, reason: "manual" });
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
        if (await clearSessionLabelViaGateway(params, session.sessionKey)) {
          closedLabelCleared += 1;
        }
        const unbound = await bindingService.unbind({ targetSessionKey: session.sessionKey, reason: "manual" });
        removedBindings += unbound.length;
        closed += 1;
      }
      clearedSessionKeys.push(session.sessionKey);
    } catch (error) {
      failed += 1;
      if (failures.length < 3) {
        failures.push(`- ${session.sessionKey}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  let ghostCleared = 0;
  let ghostFailed = 0;
  for (const ghost of ghostLabelSessions) {
    if (await clearSessionLabelViaGateway(params, ghost.sessionKey)) {
      ghostCleared += 1;
    } else {
      ghostFailed += 1;
    }
  }
  const parts = [
    `鉁?Closed ${closed}/${cursorxSessions.length} Cursor ACP session${cursorxSessions.length === 1 ? "" : "s"}.`,
    `Cleared ${closedLabelCleared}/${cursorxSessions.length} closed cursorx label${cursorxSessions.length === 1 ? "" : "s"}.`,
    `Cleared ${legacyCleared}/${legacyLabelSessions.length} legacy cursorx-start label${legacyLabelSessions.length === 1 ? "" : "s"}.`,
    `Cleared ${ghostCleared}/${ghostLabelSessions.length} ghost cursorx label${ghostLabelSessions.length === 1 ? "" : "s"}.`,
    `Removed ${removedBindings} binding${removedBindings === 1 ? "" : "s"}.`,
  ];
  if (clearedSessionKeys.length > 0) {
    const clearedSlotRefs = await clearCursorSlotPointers(params, clearedSessionKeys);
    parts.push(`Cleared ${clearedSlotRefs} cursor slot reference${clearedSlotRefs === 1 ? "" : "s"}.`);
  }
  if (failed > 0) {
    parts.push(`Failed to close ${failed} session${failed === 1 ? "" : "s"}.`);
    if (failures.length > 0) {
      parts.push(["Examples:", ...failures].join("\n"));
    }
  }
  if (ghostFailed > 0) {
    parts.push(`Failed to clear ${ghostFailed} ghost label${ghostFailed === 1 ? "" : "s"}.`);
  }
  return stopWithText(parts.join("\n"));
}

async function closeCursorSlot(params: Parameters<CommandHandler>[0], slotId: CursorxSlotId) {
  const slot = getCursorSlot(params, slotId);
  if (!slot) {
    return stopWithText(resolveMissingSlotGuidance(params, slotId));
  }
  const sessionKey = slot.acpSessionKey?.trim();
  if (!sessionKey) {
    await updateCursorSlot(params, slotId, () => undefined);
    return stopWithText(`鉁?Cleared ${slotId}.`);
  }
  const acpManager = getAcpSessionManager();
  const bindingService = getSessionBindingService();
  await acpManager.closeSession({
    cfg: params.cfg,
    sessionKey,
    reason: "manual-close",
    allowBackendUnavailable: true,
    clearMeta: true,
  });
  await clearSessionLabelViaGateway(params, sessionKey);
  const removedBindings = await bindingService.unbind({ targetSessionKey: sessionKey, reason: "manual" });
  await updateCursorSlot(params, slotId, () => undefined);
  await clearCursorSlotPointers(params, [sessionKey]);
  return stopWithText(
    `鉁?Closed ${slotId} (${sessionKey}). Removed ${removedBindings.length} binding${removedBindings.length === 1 ? "" : "s"}.`,
  );
}

async function runSlotWizardStep(params: {
  commandParams: Parameters<CommandHandler>[0];
  slotId: CursorxSlotId;
  translatedBody: string;
  includeSlotChosenPrefix?: boolean;
}) {
  const { commandParams, slotId } = params;
  const match = matchPluginCommand(params.translatedBody);
  if (!match || match.command.name !== "sandbox-start") {
    await updateCursorSlot(commandParams, slotId, (slot) =>
      slot ? { ...slot, wizardPending: false, updatedAt: Date.now() } : undefined,
    );
    return stopWithText(
      " /cursor-start requires the start-ai-project plugin command `/sandbox-start`, but it is unavailable.",
    );
  }

  const sandboxResult = await executePluginCommand({
    command: match.command,
    args: match.args,
    senderId: commandParams.command.senderId,
    channel: commandParams.command.channel,
    channelId: commandParams.command.channelId,
    isAuthorizedSender: commandParams.command.isAuthorizedSender,
    gatewayClientScopes: commandParams.ctx.GatewayClientScopes,
    commandBody: params.translatedBody,
    config: commandParams.cfg,
    from: commandParams.command.from,
    to: commandParams.command.to,
    accountId: commandParams.ctx.AccountId ?? undefined,
    messageThreadId:
      typeof commandParams.ctx.MessageThreadId === "string" || typeof commandParams.ctx.MessageThreadId === "number"
        ? commandParams.ctx.MessageThreadId
        : undefined,
  });

  const sandboxText = rewriteSandboxWizardTextForSlot(
    typeof sandboxResult.text === "string" ? sandboxResult.text : "",
    slotId,
  );
  const prefix = params.includeSlotChosenPrefix
    ? `${slotId} is chosen.\nPlease reply /${slotId} <...> to continue.\n\n`
    : "";

  if (!sandboxText.includes("Sandbox ready.")) {
    await updateCursorSlot(commandParams, slotId, (slot) => ({
      ...(slot ?? { updatedAt: Date.now() }),
      wizardPending: true,
      updatedAt: Date.now(),
    }));
    return {
      shouldContinue: false,
      reply: {
        ...sandboxResult,
        ...(typeof sandboxResult.text === "string" ? { text: `${prefix}${sandboxText}` } : {}),
      },
    };
  }

  const workspacePath = parseSandboxWorkspace(sandboxText);
  if (!workspacePath) {
    return stopWithText(`${prefix}${sandboxText}\n\nCould not parse sandbox workspace path for ACP handoff.`);
  }

  const slotLabel = resolveSlotLabel(slotId);
  const ghostLabelResult = await clearGhostLabelIfExists(commandParams, slotLabel);
  if (ghostLabelResult.failed > 0) {
    return stopWithText(
      `${prefix}${sandboxText}\n\nCould not clear stale ${slotLabel} labels before ACP handoff (${ghostLabelResult.failed} failed).`,
    );
  }

  const harnessId = commandParams.cfg.acp?.defaultAgent?.trim() || DEFAULT_HARNESS_ID;
  const sessionKey = buildCursorxSessionKey({ agentId: harnessId, hostSessionKey: commandParams.sessionKey, slotId });
  const spawnTokens = [harnessId, "--mode", "persistent", "--thread", "off", "--cwd", workspacePath, "--label", slotLabel];
  const cursorxSpawnParams = {
    ...commandParams,
    cfg: {
      ...commandParams.cfg,
      acp: { ...commandParams.cfg.acp, backend: "cursorx" },
    },
  };
  const spawnResult = await handleAcpSpawnAction(cursorxSpawnParams, spawnTokens, { sessionKeyOverride: sessionKey });
  const spawnText = spawnResult.reply?.text ?? "";
  if (!spawnText.includes(sessionKey)) {
    return stopWithText(`${prefix}${sandboxText}\n\n${spawnText || "ACP spawn did not return a session key."}`);
  }

  await updateCursorSlot(commandParams, slotId, () => ({
    acpSessionKey: sessionKey,
    intent: parseSandboxIntent(sandboxText),
    workspacePath,
    wizardPending: false,
    updatedAt: Date.now(),
  }));
  const steerResult = await handleAcpSteerAction(commandParams, ["--session", sessionKey, "APB"]);
  const steerText = steerResult.reply?.text ?? `鉁?APB trigger sent to ${sessionKey}.`;
  return { shouldContinue: false, reply: { text: `${prefix}${sandboxText}\n\n${spawnText}\n\n${steerText}` } };
}

export const handleCursorxCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const commandBody = params.command.commandBodyNormalized.trim();

  const stopAllRest = parseCommandPrefix(commandBody, STOP_ALL_COMMAND);
  if (stopAllRest !== null) {
    const rest = stopAllRest.toLowerCase();
    if (rest !== "stop") {
      return stopWithText(CURSOR_ALL_USAGE);
    }
    const unauthorized = rejectUnauthorizedCommand(params, STOP_ALL_COMMAND);
    if (unauthorized) {
      return unauthorized;
    }
    return await handleCursorStopAll(params);
  }

  const stopRestRaw = parseCommandPrefix(commandBody, STOP_COMMAND);
  if (stopRestRaw !== null) {
    const restRaw = stopRestRaw;
    const rest = restRaw.toLowerCase();
    if (!restRaw || rest === "help") {
      return stopWithText(STOP_USAGE);
    }
    const unauthorized = rejectUnauthorizedCommand(params, STOP_COMMAND);
    if (unauthorized) {
      return unauthorized;
    }
    if (rest === "all") {
      return await handleCursorStopAll(params);
    }
    if (CURSOR_SLOT_IDS.includes(rest as CursorxSlotId)) {
      return await closeCursorSlot(params, rest as CursorxSlotId);
    }
    return stopWithText(STOP_USAGE);
  }

  const slotCommand = parseCursorSlotCommand(commandBody);
  if (slotCommand) {
    const unauthorized = rejectUnauthorizedCommand(params, `/${slotCommand.slotId}`);
    if (unauthorized) {
      return unauthorized;
    }
    if (!resolveEnabledSlotIds(params).includes(slotCommand.slotId)) {
      return stopWithText(
        `${slotCommand.slotId} is outside configured max sessions (${resolveEnabledSlotIds(params).length}).`,
      );
    }
    if (slotCommand.rest.toLowerCase() === "stop") {
      return await closeCursorSlot(params, slotCommand.slotId);
    }
    const slot = getCursorSlot(params, slotCommand.slotId);
    if (!slot) {
      return stopWithText(resolveMissingSlotGuidance(params, slotCommand.slotId));
    }

    const slotSessionKey = slot.acpSessionKey?.trim();
    if (slotSessionKey) {
      const instruction = slotCommand.rest.trim();
      if (!instruction) {
        return stopWithText(`Usage: /${slotCommand.slotId} <message>`);
      }
      const steerResult = await handleAcpSteerAction(params, ["--session", slotSessionKey, instruction]);
      if (steerResult.reply?.text) {
        return {
          ...steerResult,
          reply: { ...steerResult.reply, text: `${slotCommand.slotId} selected.\n${steerResult.reply.text}` },
        };
      }
      return steerResult;
    }

    return await runSlotWizardStep({
      commandParams: params,
      slotId: slotCommand.slotId,
      translatedBody: slotCommand.rest ? `${SANDBOX_COMMAND} ${slotCommand.rest}` : SANDBOX_COMMAND,
    });
  }

  const parsed = parseCursorxStartArgs(commandBody);
  if (!parsed.ok) {
    const groupGuard = resolveGroupFlowGuidanceForNonCursorInput(params, commandBody);
    if (groupGuard) {
      return stopWithText(groupGuard);
    }
    return null;
  }
  if (!parsed.translatedBody) {
    return stopWithText(START_USAGE);
  }

  const unauthorized = rejectUnauthorizedCommand(params, COMMAND);
  if (unauthorized) {
    return unauthorized;
  }

  await cleanupOrphanedCursorxAcpSessions(params, await listCursorxAcpSessions(params));
  const allocated = await reserveNextCursorSlot(params);
  if (!allocated) {
    return stopWithText("No available session, please wait.");
  }

  return await runSlotWizardStep({
    commandParams: params,
    slotId: allocated.slotId,
    translatedBody: parsed.translatedBody,
    includeSlotChosenPrefix: true,
  });
};



