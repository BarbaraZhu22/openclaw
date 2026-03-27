import { describe, expect, it } from "vitest";
import {
  createCursorxPluginConfigSchema,
  resolveCursorxPluginConfig,
  type ResolvedCursorxPluginConfig,
} from "./config.js";

describe("cursorx config", () => {
  it("resolves sane defaults", () => {
    const resolved = resolveCursorxPluginConfig({});
    expect(resolved.command).toBe("agent");
    expect(resolved.defaultRuntimeMode).toBe("plan");
    expect(resolved.permissionMode).toBe("approve-reads");
    expect(resolved.autoApproveMcpServers).toBe(true);
    expect(resolved.trustWorkspace).toBe(true);
  });

  it("accepts explicit config overrides", () => {
    const resolved = resolveCursorxPluginConfig({
      workspaceDir: "D:/repo",
      rawConfig: {
        command: "agent",
        cwd: "./sandbox",
        defaultRuntimeMode: "agent",
        permissionMode: "approve-all",
        autoApproveMcpServers: false,
        trustWorkspace: false,
        args: ["--api-key", "test"],
      } satisfies Partial<ResolvedCursorxPluginConfig>,
    });
    expect(resolved.cwd).toContain("sandbox");
    expect(resolved.defaultRuntimeMode).toBe("agent");
    expect(resolved.permissionMode).toBe("approve-all");
    expect(resolved.autoApproveMcpServers).toBe(false);
    expect(resolved.trustWorkspace).toBe(false);
    expect(resolved.args).toEqual(["--api-key", "test"]);
  });

  it("rejects invalid schema values", () => {
    const schema = createCursorxPluginConfigSchema();
    const result = schema.safeParse({
      permissionMode: "nope",
    });
    expect(result.success).toBe(false);
  });
});
