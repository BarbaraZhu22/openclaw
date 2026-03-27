import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type {
  AcpRuntime,
  AcpRuntimeCapabilities,
  AcpRuntimeDoctorReport,
  AcpRuntimeEnsureInput,
  AcpRuntimeEvent,
  AcpRuntimeHandle,
  AcpRuntimeStatus,
  AcpRuntimeTurnInput,
  PluginLogger,
} from "../runtime-api.js";
import { AcpRuntimeError } from "../runtime-api.js";
import type { CursorxPermissionMode, ResolvedCursorxPluginConfig } from "./config.js";

export const CURSORX_BACKEND_ID = "cursorx";

const CURSORX_RUNTIME_HANDLE_PREFIX = "cursorx:v1:";

type CursorxHandleState = {
  id: string;
  name: string;
  cwd: string;
};

type CursorxSession = {
  state: CursorxHandleState;
  sessionKey: string;
  cwd: string;
  connection: ClientSideConnection;
  child: ChildProcessWithoutNullStreams;
  acpSessionId: string;
  runtimeMode: string;
  activeTurn: RuntimeEventQueue | null;
  lastStatusText?: string;
};

type TurnLogState = {
  mode: "prompt" | "steer";
  outputText: string;
  sawThought: boolean;
  sawToolCall: boolean;
};

class RuntimeEventQueue {
  private readonly items: AcpRuntimeEvent[] = [];
  private done = false;
  private pendingResolve: ((result: IteratorResult<AcpRuntimeEvent>) => void) | null = null;

  push(event: AcpRuntimeEvent): void {
    if (this.done) {
      return;
    }
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: event, done: false });
      return;
    }
    this.items.push(event);
  }

  end(): void {
    if (this.done) {
      return;
    }
    this.done = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<AcpRuntimeEvent>> {
    if (this.items.length > 0) {
      const value = this.items.shift();
      if (value) {
        return { value, done: false };
      }
    }
    if (this.done) {
      return { value: undefined, done: true };
    }
    return await new Promise<IteratorResult<AcpRuntimeEvent>>((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<AcpRuntimeEvent> {
    return {
      next: () => this.next(),
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function encodeCursorxRuntimeHandleState(state: CursorxHandleState): string {
  const payload = Buffer.from(JSON.stringify(state), "utf8").toString("base64url");
  return `${CURSORX_RUNTIME_HANDLE_PREFIX}${payload}`;
}

function decodeCursorxRuntimeHandleState(runtimeSessionName: string): CursorxHandleState | null {
  const trimmed = runtimeSessionName.trim();
  if (!trimmed.startsWith(CURSORX_RUNTIME_HANDLE_PREFIX)) {
    return null;
  }
  const encoded = trimmed.slice(CURSORX_RUNTIME_HANDLE_PREFIX.length);
  if (!encoded) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    const id = asString(parsed.id);
    const name = asString(parsed.name);
    const cwd = asString(parsed.cwd);
    if (!id || !name || !cwd) {
      return null;
    }
    return { id, name, cwd };
  } catch {
    return null;
  }
}

function pickPermissionOption(
  options: Array<{ kind: string; optionId: string }>,
  kinds: string[],
): string | null {
  for (const kind of kinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return match.optionId;
    }
  }
  return null;
}

function resolveToolName(request: RequestPermissionRequest): string | undefined {
  const title = request.toolCall?.title;
  if (!title) {
    return undefined;
  }
  const head = title.split(":", 1)[0]?.trim().toLowerCase();
  return head || undefined;
}

function shouldApproveTool(params: {
  permissionMode: CursorxPermissionMode;
  request: RequestPermissionRequest;
}): boolean {
  if (params.permissionMode === "deny-all") {
    return false;
  }
  if (params.permissionMode === "approve-all") {
    return true;
  }
  const toolName = resolveToolName(params.request);
  if (!toolName) {
    return false;
  }
  return toolName.includes("read") || toolName.includes("search");
}

function resolvePermissionResponse(params: {
  permissionMode: CursorxPermissionMode;
  request: RequestPermissionRequest;
}): RequestPermissionResponse {
  const options = params.request.options ?? [];
  const allowOptionId = pickPermissionOption(options, ["allow_once", "allow_always"]);
  const rejectOptionId = pickPermissionOption(options, ["reject_once", "reject_always"]);
  const approved = shouldApproveTool(params);
  if (approved && allowOptionId) {
    return { outcome: { outcome: "selected", optionId: allowOptionId } };
  }
  if (!approved && rejectOptionId) {
    return { outcome: { outcome: "selected", optionId: rejectOptionId } };
  }
  return { outcome: { outcome: "cancelled" } };
}

function mapSessionUpdateToEvents(notification: SessionNotification): AcpRuntimeEvent[] {
  const update = notification.update;
  if (!("sessionUpdate" in update)) {
    return [];
  }

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text =
        update.content?.type === "text" ? update.content.text : asString((update as { text?: unknown }).text);
      return text
        ? [{ type: "text_delta", text, stream: "output", tag: "agent_message_chunk" }]
        : [];
    }
    case "agent_thought_chunk": {
      const text =
        update.content?.type === "text" ? update.content.text : asString((update as { text?: unknown }).text);
      return text
        ? [{ type: "text_delta", text, stream: "thought", tag: "agent_thought_chunk" }]
        : [];
    }
    case "tool_call":
    case "tool_call_update": {
      const title = asString(update.title) ?? "tool call";
      const status = asString(update.status);
      return [
        {
          type: "tool_call",
          text: status ? `${title} (${status})` : title,
          tag: update.sessionUpdate,
          ...(asString(update.toolCallId) ? { toolCallId: asString(update.toolCallId) } : {}),
          ...(status ? { status } : {}),
          title,
        },
      ];
    }
    case "usage_update": {
      const used = typeof update.used === "number" ? update.used : undefined;
      const size = typeof update.size === "number" ? update.size : undefined;
      const text =
        used != null && size != null ? `usage updated: ${used}/${size}` : "usage updated";
      return [
        {
          type: "status",
          text,
          tag: "usage_update",
          ...(used != null ? { used } : {}),
          ...(size != null ? { size } : {}),
        },
      ];
    }
    case "available_commands_update":
      return [{ type: "status", text: "available commands updated", tag: "available_commands_update" }];
    case "current_mode_update": {
      const mode = asString((update as { currentModeId?: unknown }).currentModeId) ?? asString((update as { mode?: unknown }).mode);
      return [
        {
          type: "status",
          text: mode ? `mode updated: ${mode}` : "mode updated",
          tag: "current_mode_update",
        },
      ];
    }
    case "config_option_update":
      return [{ type: "status", text: "config updated", tag: "config_option_update" }];
    case "session_info_update": {
      const summary = asString((update as { summary?: unknown }).summary) ?? "session updated";
      return [{ type: "status", text: summary, tag: "session_info_update" }];
    }
    case "plan": {
      const entries = Array.isArray((update as { entries?: unknown }).entries)
        ? ((update as { entries: unknown[] }).entries as unknown[])
        : [];
      const first = entries.find((entry) => isRecord(entry) && asString((entry as { content?: unknown }).content));
      const content =
        first && isRecord(first) ? asString((first as { content?: unknown }).content) : undefined;
      return [
        {
          type: "status",
          text: content ? `plan: ${content}` : "plan updated",
          tag: "plan",
        },
      ];
    }
    default:
      return [];
  }
}

export class CursorxRuntime implements AcpRuntime {
  private readonly sessionsById = new Map<string, CursorxSession>();
  private readonly logger?: PluginLogger;
  private healthy = true;

  constructor(
    private readonly config: ResolvedCursorxPluginConfig,
    opts?: { logger?: PluginLogger },
  ) {
    this.logger = opts?.logger;
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private buildSpawnArgs(): string[] {
    const args = [...this.config.args];
    if (this.config.autoApproveMcpServers) {
      args.push("--approve-mcps");
    }
    if (this.config.trustWorkspace) {
      args.push("--trust");
    }
    args.push("acp");
    return args;
  }

  private logDebug(message: string): void {
    this.logger?.debug?.(`[cursorx] ${message}`);
  }

  private logInfo(message: string): void {
    this.logger?.info(`[cursorx] ${message}`);
  }

  private logWarn(message: string): void {
    this.logger?.warn(`[cursorx] ${message}`);
  }

  private appendTruncated(current: string, next: string, limit = 240): string {
    if (!next) {
      return current;
    }
    const merged = current + next;
    if (merged.length <= limit) {
      return merged;
    }
    return `${merged.slice(0, limit)}…`;
  }

  private async createSession(input: AcpRuntimeEnsureInput): Promise<CursorxSession> {
    const cwd = input.cwd?.trim() || this.config.cwd;
    const args = this.buildSpawnArgs();
    this.logInfo(
      `spawning Cursor ACP process (session=${input.sessionKey}, cwd=${cwd}, command=${this.config.command} ${args.join(" ")})`,
    );
    const child = spawn(this.config.command, args, {
      cwd,
      env: {
        ...process.env,
        OPENCLAW_SHELL: "acp",
      },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    if (!child.stdin || !child.stdout) {
      throw new AcpRuntimeError("ACP_BACKEND_NOT_AVAILABLE", "Could not open Cursor ACP pipes.");
    }
    child.once("exit", (code, signal) => {
      const reason =
        signal != null ? `signal=${signal}` : code != null ? `exitCode=${code}` : "exitCode=unknown";
      this.logWarn(`Cursor ACP process exited (session=${input.sessionKey}, ${reason})`);
    });

    const inputStream = Writable.toWeb(child.stdin);
    const outputStream = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(inputStream, outputStream);
    const state: CursorxHandleState = {
      id: randomUUID(),
      name: input.sessionKey,
      cwd,
    };
    const session: CursorxSession = {
      state,
      sessionKey: input.sessionKey,
      cwd,
      connection: new ClientSideConnection(
        () => ({
          sessionUpdate: async (params: SessionNotification) => {
            const mapped = mapSessionUpdateToEvents(params);
            if (mapped.length === 0) {
              return;
            }
            const current = this.sessionsById.get(state.id);
            if (!current?.activeTurn) {
              return;
            }
            for (const event of mapped) {
              if (event.type === "status") {
                current.lastStatusText = event.text;
                this.logDebug(`status (session=${current.sessionKey}): ${event.text}`);
              }
              this.captureTurnLogEvent(current, event);
              current.activeTurn.push(event);
            }
          },
          requestPermission: async (params: RequestPermissionRequest) => {
            return resolvePermissionResponse({
              permissionMode: this.config.permissionMode,
              request: params,
            });
          },
        }),
        stream,
      ),
      child,
      acpSessionId: "",
      runtimeMode: this.config.defaultRuntimeMode,
      activeTurn: null,
    };

    await session.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: "openclaw-cursorx", version: "1.0.0" },
    });

    if (input.resumeSessionId?.trim()) {
      const loaded = await session.connection.loadSession({
        sessionId: input.resumeSessionId.trim(),
        mcpServers: [],
      });
      session.acpSessionId = loaded.sessionId;
      this.logInfo(`connected to existing Cursor session (session=${input.sessionKey}, backendSessionId=${session.acpSessionId})`);
    } else {
      const created = await session.connection.newSession({
        cwd,
        mcpServers: [],
      });
      session.acpSessionId = created.sessionId;
      this.logInfo(`created new Cursor session (session=${input.sessionKey}, backendSessionId=${session.acpSessionId})`);
    }

    if (session.runtimeMode) {
      await this.setSessionMode(session, session.runtimeMode);
    }
    this.sessionsById.set(state.id, session);
    return session;
  }

  private captureTurnLogEvent(session: CursorxSession, event: AcpRuntimeEvent): void {
    const turnLog = (session.activeTurn as RuntimeEventQueue & { __turnLog?: TurnLogState } | null)?.__turnLog;
    if (!turnLog) {
      return;
    }
    if (event.type === "text_delta") {
      if (!event.text) {
        return;
      }
      if (!event.stream || event.stream === "output") {
        turnLog.outputText = this.appendTruncated(turnLog.outputText, event.text);
      } else if (event.stream === "thought") {
        turnLog.sawThought = true;
      }
      return;
    }
    if (event.type === "tool_call") {
      turnLog.sawToolCall = true;
    }
  }

  private async setSessionMode(session: CursorxSession, mode: string): Promise<void> {
    const api = session.connection as unknown as {
      setSessionMode?: (params: { sessionId: string; modeId: string }) => Promise<unknown>;
    };
    if (!api.setSessionMode) {
      return;
    }
    await api.setSessionMode({
      sessionId: session.acpSessionId,
      modeId: mode,
    });
    session.runtimeMode = mode;
    this.logInfo(`mode set to ${mode} (session=${session.sessionKey}, backendSessionId=${session.acpSessionId})`);
  }

  private resolveSessionFromHandle(handle: AcpRuntimeHandle): CursorxSession {
    const decoded = decodeCursorxRuntimeHandleState(handle.runtimeSessionName);
    if (!decoded) {
      throw new AcpRuntimeError("ACP_SESSION_NOT_FOUND", "Cursor session handle is invalid.");
    }
    const session = this.sessionsById.get(decoded.id);
    if (!session) {
      throw new AcpRuntimeError("ACP_SESSION_NOT_FOUND", "Cursor session no longer exists.");
    }
    return session;
  }

  async ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle> {
    const session = await this.createSession(input);
    return {
      sessionKey: input.sessionKey,
      backend: CURSORX_BACKEND_ID,
      runtimeSessionName: encodeCursorxRuntimeHandleState(session.state),
      cwd: session.cwd,
      backendSessionId: session.acpSessionId,
    };
  }

  async *runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent> {
    const session = this.resolveSessionFromHandle(input.handle);
    const queue = new RuntimeEventQueue();
    session.activeTurn = queue;
    (
      queue as RuntimeEventQueue & {
        __turnLog?: TurnLogState;
      }
    ).__turnLog = {
      mode: input.mode,
      outputText: "",
      sawThought: false,
      sawToolCall: false,
    };
    const runId = randomUUID();
    this.logInfo(`turn started (session=${session.sessionKey}, mode=${input.mode}, requestId=${input.requestId})`);

    const maybeCancelOnAbort = () => {
      if (!input.signal || !input.signal.aborted) {
        return;
      }
      const api = session.connection as unknown as {
        cancel?: (params: { sessionId: string; runId: string }) => Promise<unknown>;
      };
      void api.cancel?.({
        sessionId: session.acpSessionId,
        runId,
      });
    };
    maybeCancelOnAbort();
    input.signal?.addEventListener("abort", maybeCancelOnAbort, { once: true });

    void (async () => {
      try {
        if (input.mode === "steer" && session.runtimeMode !== "agent") {
          await this.setSessionMode(session, "agent");
        }
        const response = await session.connection.prompt({
          sessionId: session.acpSessionId,
          runId,
          prompt: [{ type: "text", text: input.text }],
        });
        queue.push({
          type: "done",
          ...(response.stopReason ? { stopReason: response.stopReason } : {}),
        });
      } catch (error) {
        this.logWarn(
          `turn failed (session=${session.sessionKey}, mode=${input.mode}): ${error instanceof Error ? error.message : String(error)}`,
        );
        queue.push({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
          code: "ACP_TURN_FAILED",
          retryable: true,
        });
      } finally {
        queue.end();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      const turnLog = (
        queue as RuntimeEventQueue & {
          __turnLog?: TurnLogState;
        }
      ).__turnLog;
      const finalSummary = turnLog?.outputText.trim();
      if (finalSummary) {
        this.logInfo(
          `turn completed (session=${session.sessionKey}, mode=${input.mode}, final=${JSON.stringify(finalSummary)})`,
        );
      } else {
        const hints = [
          turnLog?.sawThought ? "thought-only" : null,
          turnLog?.sawToolCall ? "tool-calls" : null,
        ]
          .filter(Boolean)
          .join(", ");
        this.logInfo(
          `turn completed (session=${session.sessionKey}, mode=${input.mode}, no final output${hints ? `; observed ${hints}` : ""})`,
        );
      }
      input.signal?.removeEventListener("abort", maybeCancelOnAbort);
      session.activeTurn = null;
    }
  }

  async getCapabilities(_input: { handle?: AcpRuntimeHandle }): Promise<AcpRuntimeCapabilities> {
    return {
      controls: ["session/set_mode", "session/status"],
    };
  }

  async getStatus(input: { handle: AcpRuntimeHandle }): Promise<AcpRuntimeStatus> {
    const session = this.resolveSessionFromHandle(input.handle);
    return {
      summary: session.lastStatusText ?? `cursor mode=${session.runtimeMode}`,
      backendSessionId: session.acpSessionId,
      details: {
        cwd: session.cwd,
        mode: session.runtimeMode,
      },
    };
  }

  async setMode(input: { handle: AcpRuntimeHandle; mode: string }): Promise<void> {
    const session = this.resolveSessionFromHandle(input.handle);
    await this.setSessionMode(session, input.mode);
  }

  async doctor(): Promise<AcpRuntimeDoctorReport> {
    return {
      ok: true,
      message: `Cursor ACP backend ready (command: ${this.config.command}).`,
      details: [
        `defaultRuntimeMode=${this.config.defaultRuntimeMode}`,
        `permissionMode=${this.config.permissionMode}`,
      ],
    };
  }

  async cancel(input: { handle: AcpRuntimeHandle; reason?: string }): Promise<void> {
    const session = this.resolveSessionFromHandle(input.handle);
    const api = session.connection as unknown as {
      cancel?: (params: { sessionId: string }) => Promise<unknown>;
    };
    await api.cancel?.({ sessionId: session.acpSessionId });
    if (session.activeTurn) {
      session.activeTurn.push({
        type: "status",
        text: input.reason?.trim() ? `cancelled: ${input.reason.trim()}` : "cancelled",
      });
      session.activeTurn.end();
      session.activeTurn = null;
    }
  }

  async close(input: { handle: AcpRuntimeHandle; reason: string }): Promise<void> {
    const session = this.resolveSessionFromHandle(input.handle);
    this.sessionsById.delete(session.state.id);
    if (session.activeTurn) {
      session.activeTurn.push({
        type: "status",
        text: `session closed: ${input.reason}`,
      });
      session.activeTurn.end();
      session.activeTurn = null;
    }
    session.child.kill();
  }
}
