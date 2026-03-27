import { handleAcpSpawnAction, handleAcpSteerAction } from "./commands-acp/lifecycle.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
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

function stopWithText(text: string) {
  return {
    shouldContinue: false as const,
    reply: { text },
  };
}

function parseCursorxStartArgs(commandBody: string): { ok: true; translatedBody: string } | { ok: false } {
  if (!commandBody.startsWith(COMMAND)) {
    return { ok: false };
  }
  const rest = commandBody.slice(COMMAND.length).trim();
  if (!rest) {
    return { ok: true, translatedBody: SANDBOX_COMMAND };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens[0]?.toLowerCase() === "help") {
    return { ok: true, translatedBody: "" };
  }
  const translatedArgs = tokens[0]?.toLowerCase() === "start" ? rest.slice(tokens[0].length).trim() : rest;
  return {
    ok: true,
    translatedBody: translatedArgs ? `${SANDBOX_COMMAND} ${translatedArgs}` : SANDBOX_COMMAND,
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

export const handleCursorxCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseCursorxStartArgs(params.command.commandBodyNormalized);
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

  const sandboxText = typeof sandboxResult.text === "string" ? sandboxResult.text : "";
  if (!sandboxText.includes("Sandbox ready.")) {
    return {
      shouldContinue: false,
      reply: sandboxResult,
    };
  }

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
  const spawnResult = await handleAcpSpawnAction(params, spawnTokens);
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
