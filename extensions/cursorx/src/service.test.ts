import { describe, expect, it, vi } from "vitest";
import { getAcpRuntimeBackend } from "openclaw/plugin-sdk/acp-runtime";
import { createCursorxRuntimeService } from "./service.js";

describe("cursorx runtime service", () => {
  it("registers and unregisters cursorx backend", async () => {
    const service = createCursorxRuntimeService({
      pluginConfig: {},
      runtimeFactory: () =>
        ({
          ensureSession: vi.fn(),
          runTurn: vi.fn(),
          cancel: vi.fn(),
          close: vi.fn(),
          isHealthy: () => true,
        }) as never,
    });

    await service.start({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      workspaceDir: process.cwd(),
    });
    expect(getAcpRuntimeBackend("cursorx")).toBeTruthy();

    await service.stop({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      workspaceDir: process.cwd(),
    });
    expect(getAcpRuntimeBackend("cursorx")).toBeNull();
  });
});
