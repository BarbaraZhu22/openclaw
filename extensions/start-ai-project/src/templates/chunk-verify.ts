import type { SandboxContext } from "../types.js";

export function renderChunkVerify(ctx: SandboxContext): string {
  const commands = ctx.verifyCommands || [];
  const commandList = commands.map((command, index) => `${index + 1}. \`${command}\``).join("\n");
  const commandRun = commands
    .map((command) => `- Run \`${command}\` and fix all errors before continuing`)
    .join("\n");
  const commandInline = commands.map((command) => `\`${command}\``).join(" and ");

  return `---
description: "Chunk verification: run checks after each logical unit of work"
globs:
alwaysApply: true
---

# Chunk Verification Rules

After each logical chunk of work, verify before moving on.

## Mandatory Pre-Commit Checks

${commandList || "1. `pnpm lint`\n2. `pnpm type-check`"}

If any check fails, fix it before committing.

## After Each Chunk

1. Summarize what changed in this chunk
${commandRun || "- Run `pnpm lint` and fix all errors\n- Run `pnpm type-check` and fix all errors"}
- Run any additional verify commands from \`.ai/task.md\`
2. Only after all checks pass, commit with a clear message
3. Update plan/todo state

## Rules

- NEVER commit without running ${commandInline || "`pnpm lint` and `pnpm type-check`"}
- If checks fail, fix in the same chunk before moving forward
- Keep chunks focused and reviewable
`;
}
