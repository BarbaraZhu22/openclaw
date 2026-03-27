import { handleAcpSpawnAction, handleAcpSteerAction } from "./commands-acp/lifecycle.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import { executePluginCommand, matchPluginCommand } from "../../plugins/commands.js";

const COMMAND = "/cursor-start";
const SANDBOX_COMMAND = "/sandbox-start";
const DEFAULT_HARNESS_ID = "codex";
const START_USAGE = [
  "Usage:",
  "/cursor-start start",
  "/cursor-start start repoId=<id> intent=\"<task>\"",
  "/cursor-start <wizard-reply>",
].join("\n");

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
  const hasPendingWizard = params.sessionEntry?.cursorStartPending === true;
  const parsed = parseCursorxStartArgs(params.command.commandBodyNormalized, hasPendingWizard);
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
    return {
      shouldContinue: false,
      reply: {
        text:
          `${sandboxText}\n\n` +
          "⚠️ Could not parse sandbox workspace path for ACP handoff. " +
          `Run: /acp spawn ${params.cfg.acp?.defaultAgent?.trim() || DEFAULT_HARNESS_ID} --thread here`,
      },
    };
  }

  const harnessId = params.cfg.acp?.defaultAgent?.trim() || DEFAULT_HARNESS_ID;
  const spawnTokens = [
    harnessId,
    "--mode",
    "persistent",
    "--thread",
    "here",
    "--cwd",
    workspacePath,
    "--label",
    "cursorx-start",
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
