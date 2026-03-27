import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCursorxPluginConfig } from "./config.js";

const mockSetSessionMode = vi.fn();
const mockPrompt = vi.fn();
const mockNewSession = vi.fn();
const mockLoadSession = vi.fn();
const mockCancel = vi.fn();
const mockHandlers: Array<{
  sessionUpdate: (params: unknown) => Promise<void>;
  requestPermission: (params: unknown) => Promise<unknown>;
}> = [];

vi.mock("node:child_process", () => {
  return {
    spawn: vi.fn(() => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      return {
        stdin,
        stdout,
        kill: vi.fn(),
      };
    }),
  };
});

vi.mock("@agentclientprotocol/sdk", () => {
  class MockClientSideConnection {
    private readonly handlers: {
      sessionUpdate: (params: unknown) => Promise<void>;
      requestPermission: (params: unknown) => Promise<unknown>;
    };
    constructor(factory: () => {
      sessionUpdate: (params: unknown) => Promise<void>;
      requestPermission: (params: unknown) => Promise<unknown>;
    }) {
      this.handlers = factory();
      mockHandlers.push(this.handlers);
    }
    async initialize() {}
    async newSession() {
      return await mockNewSession();
    }
    async loadSession() {
      return await mockLoadSession();
    }
    async prompt() {
      return await mockPrompt(this.handlers);
    }
    async setSessionMode(params: { sessionId: string; modeId: string }) {
      return await mockSetSessionMode(params);
    }
    async cancel(params: { sessionId: string }) {
      return await mockCancel(params);
    }
  }
  return {
    PROTOCOL_VERSION: 1,
    ndJsonStream: vi.fn(() => ({})),
    ClientSideConnection: MockClientSideConnection,
  };
});

describe("CursorxRuntime", () => {
  beforeEach(() => {
    mockHandlers.length = 0;
    mockSetSessionMode.mockReset().mockResolvedValue(undefined);
    mockCancel.mockReset().mockResolvedValue(undefined);
    mockNewSession.mockReset().mockResolvedValue({ sessionId: "cursor-session-1" });
    mockLoadSession.mockReset().mockResolvedValue({ sessionId: "cursor-session-loaded" });
    mockPrompt.mockReset().mockImplementation(async (handlers) => {
      await handlers.sessionUpdate({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "plan output" },
        },
      });
      return { stopReason: "end_turn" };
    });
  });

  it("creates a cursorx session and emits prompt events", async () => {
    const { CursorxRuntime } = await import("./runtime.js");
    const runtime = new CursorxRuntime({
      command: "agent",
      cwd: process.cwd(),
      defaultRuntimeMode: "plan",
      permissionMode: "approve-reads",
      autoApproveMcpServers: true,
      trustWorkspace: true,
      args: [],
    } satisfies ResolvedCursorxPluginConfig);

    const handle = await runtime.ensureSession({
      sessionKey: "agent:main:acp:cursorx",
      agent: "cursor",
      mode: "persistent",
      cwd: process.cwd(),
    });
    expect(handle.backend).toBe("cursorx");
    expect(mockSetSessionMode).toHaveBeenCalledWith({
      sessionId: "cursor-session-1",
      modeId: "plan",
    });

    const events = [];
    for await (const event of runtime.runTurn({
      handle,
      mode: "prompt",
      text: "Make a plan",
      requestId: "req-1",
    })) {
      events.push(event);
    }
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "text_delta",
          text: "plan output",
          tag: "agent_message_chunk",
        }),
        expect.objectContaining({ type: "done", stopReason: "end_turn" }),
      ]),
    );
  });

  it("switches to agent mode for steer turns", async () => {
    const { CursorxRuntime } = await import("./runtime.js");
    const runtime = new CursorxRuntime({
      command: "agent",
      cwd: process.cwd(),
      defaultRuntimeMode: "plan",
      permissionMode: "approve-reads",
      autoApproveMcpServers: true,
      trustWorkspace: true,
      args: [],
    } satisfies ResolvedCursorxPluginConfig);

    const handle = await runtime.ensureSession({
      sessionKey: "agent:main:acp:cursorx-2",
      agent: "cursor",
      mode: "persistent",
      cwd: process.cwd(),
    });

    mockSetSessionMode.mockClear();
    for await (const _event of runtime.runTurn({
      handle,
      mode: "steer",
      text: "Continue with implementation",
      requestId: "req-2",
    })) {
      // consume
    }
    expect(mockSetSessionMode).toHaveBeenCalledWith({
      sessionId: "cursor-session-1",
      modeId: "agent",
    });
  });
});
