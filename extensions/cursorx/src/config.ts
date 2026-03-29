import path from "node:path";
import type { OpenClawPluginConfigSchema } from "../runtime-api.js";

export const CURSORX_PERMISSION_MODES = ["approve-all", "approve-reads", "deny-all"] as const;
export type CursorxPermissionMode = (typeof CURSORX_PERMISSION_MODES)[number];
export const CURSORX_DEFAULT_RUNTIME_MODES = ["plan", "agent", "ask"] as const;
export type CursorxDefaultRuntimeMode = (typeof CURSORX_DEFAULT_RUNTIME_MODES)[number];

export type CursorxPluginConfig = {
  command?: string;
  cwd?: string;
  defaultRuntimeMode?: CursorxDefaultRuntimeMode;
  permissionMode?: CursorxPermissionMode;
  maxSessions?: number;
  autoApproveMcpServers?: boolean;
  trustWorkspace?: boolean;
  args?: string[];
};

export type ResolvedCursorxPluginConfig = {
  command: string;
  cwd: string;
  defaultRuntimeMode: CursorxDefaultRuntimeMode;
  permissionMode: CursorxPermissionMode;
  maxSessions: number;
  autoApproveMcpServers: boolean;
  trustWorkspace: boolean;
  args: string[];
};

const DEFAULT_PERMISSION_MODE: CursorxPermissionMode = "approve-reads";
const DEFAULT_RUNTIME_MODE: CursorxDefaultRuntimeMode = "plan";
const DEFAULT_MAX_SESSIONS = 5;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCursorxPluginConfig(value: unknown):
  | { ok: true; value: CursorxPluginConfig | undefined }
  | { ok: false; message: string } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!isRecord(value)) {
    return { ok: false, message: "expected config object" };
  }

  const allowedKeys = new Set([
    "command",
    "cwd",
    "defaultRuntimeMode",
    "permissionMode",
    "maxSessions",
    "autoApproveMcpServers",
    "trustWorkspace",
    "args",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, message: `unknown config key: ${key}` };
    }
  }

  const command = value.command;
  if (command !== undefined && (typeof command !== "string" || !command.trim())) {
    return { ok: false, message: "command must be a non-empty string" };
  }
  const cwd = value.cwd;
  if (cwd !== undefined && (typeof cwd !== "string" || !cwd.trim())) {
    return { ok: false, message: "cwd must be a non-empty string" };
  }
  const defaultRuntimeMode = value.defaultRuntimeMode;
  if (
    defaultRuntimeMode !== undefined &&
    (typeof defaultRuntimeMode !== "string" ||
      !CURSORX_DEFAULT_RUNTIME_MODES.includes(defaultRuntimeMode as CursorxDefaultRuntimeMode))
  ) {
    return {
      ok: false,
      message: `defaultRuntimeMode must be one of: ${CURSORX_DEFAULT_RUNTIME_MODES.join(", ")}`,
    };
  }
  const permissionMode = value.permissionMode;
  if (
    permissionMode !== undefined &&
    (typeof permissionMode !== "string" ||
      !CURSORX_PERMISSION_MODES.includes(permissionMode as CursorxPermissionMode))
  ) {
    return {
      ok: false,
      message: `permissionMode must be one of: ${CURSORX_PERMISSION_MODES.join(", ")}`,
    };
  }
  if (
    value.maxSessions !== undefined &&
    (typeof value.maxSessions !== "number" ||
      !Number.isFinite(value.maxSessions) ||
      !Number.isInteger(value.maxSessions) ||
      value.maxSessions < 1)
  ) {
    return { ok: false, message: "maxSessions must be a positive integer" };
  }
  if (
    value.autoApproveMcpServers !== undefined &&
    typeof value.autoApproveMcpServers !== "boolean"
  ) {
    return { ok: false, message: "autoApproveMcpServers must be a boolean" };
  }
  if (value.trustWorkspace !== undefined && typeof value.trustWorkspace !== "boolean") {
    return { ok: false, message: "trustWorkspace must be a boolean" };
  }
  if (value.args !== undefined) {
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
      return { ok: false, message: "args must be an array of strings" };
    }
  }

  return {
    ok: true,
    value: {
      command: typeof command === "string" ? command.trim() : undefined,
      cwd: typeof cwd === "string" ? cwd.trim() : undefined,
      defaultRuntimeMode:
        typeof defaultRuntimeMode === "string"
          ? (defaultRuntimeMode as CursorxDefaultRuntimeMode)
          : undefined,
      permissionMode:
        typeof permissionMode === "string" ? (permissionMode as CursorxPermissionMode) : undefined,
      maxSessions: typeof value.maxSessions === "number" ? value.maxSessions : undefined,
      autoApproveMcpServers:
        typeof value.autoApproveMcpServers === "boolean" ? value.autoApproveMcpServers : undefined,
      trustWorkspace: typeof value.trustWorkspace === "boolean" ? value.trustWorkspace : undefined,
      args: Array.isArray(value.args) ? value.args.map((arg) => arg.trim()).filter(Boolean) : undefined,
    },
  };
}

export function createCursorxPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    safeParse(value: unknown) {
      const parsed = parseCursorxPluginConfig(value);
      if (parsed.ok) {
        return { success: true, data: parsed.value };
      }
      return {
        success: false,
        error: { issues: [{ path: [], message: parsed.message }] },
      };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        defaultRuntimeMode: { type: "string", enum: [...CURSORX_DEFAULT_RUNTIME_MODES] },
        permissionMode: { type: "string", enum: [...CURSORX_PERMISSION_MODES] },
        maxSessions: { type: "integer", minimum: 1 },
        autoApproveMcpServers: { type: "boolean" },
        trustWorkspace: { type: "boolean" },
        args: { type: "array", items: { type: "string" } },
      },
    },
  };
}

export function resolveCursorxPluginConfig(params: {
  rawConfig?: unknown;
  workspaceDir?: string;
}): ResolvedCursorxPluginConfig {
  const parsed = parseCursorxPluginConfig(params.rawConfig);
  if (!parsed.ok) {
    throw new Error(`Invalid cursorx plugin config: ${parsed.message}`);
  }
  const value = parsed.value ?? {};
  const baseDir = params.workspaceDir?.trim() || process.cwd();
  const command = value.command?.trim() || "agent";
  const cwdRaw = value.cwd?.trim() || baseDir;
  const cwd = path.resolve(baseDir, cwdRaw);
  return {
    command,
    cwd,
    defaultRuntimeMode: value.defaultRuntimeMode ?? DEFAULT_RUNTIME_MODE,
    permissionMode: value.permissionMode ?? DEFAULT_PERMISSION_MODE,
    maxSessions: value.maxSessions ?? DEFAULT_MAX_SESSIONS,
    autoApproveMcpServers: value.autoApproveMcpServers ?? true,
    trustWorkspace: value.trustWorkspace ?? true,
    args: value.args ?? [],
  };
}
