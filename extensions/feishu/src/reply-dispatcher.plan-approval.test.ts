import { describe, expect, it } from "vitest";
import { shouldEmitCursorxPlanApproval } from "./reply-dispatcher.js";

describe("shouldEmitCursorxPlanApproval", () => {
  it("returns true for cursorx plan mode", () => {
    expect(
      shouldEmitCursorxPlanApproval({
        acp: {
          backend: "cursorx",
          runtimeOptions: {
            runtimeMode: "plan",
          },
        },
      }),
    ).toBe(true);
  });

  it("returns true when mode is unset for cursorx", () => {
    expect(
      shouldEmitCursorxPlanApproval({
        acp: {
          backend: "cursorx",
          runtimeOptions: {},
        },
      }),
    ).toBe(true);
  });

  it("returns false for non-cursorx backends", () => {
    expect(
      shouldEmitCursorxPlanApproval({
        acp: {
          backend: "acpx",
          runtimeOptions: {
            runtimeMode: "plan",
          },
        },
      }),
    ).toBe(false);
  });

  it("returns false when cursorx is already in agent mode", () => {
    expect(
      shouldEmitCursorxPlanApproval({
        acp: {
          backend: "cursorx",
          runtimeOptions: {
            runtimeMode: "agent",
          },
        },
      }),
    ).toBe(false);
  });
});
