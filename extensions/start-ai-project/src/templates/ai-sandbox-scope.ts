import type { SandboxContext } from "../types.js";

export function renderSandboxScope(ctx: SandboxContext): string {
  const allowed = (ctx.allowedPaths || []).map((pattern) => `- \`${pattern}\``).join("\n");
  const forbidden = (ctx.forbiddenPaths || []).map((pattern) => `- \`${pattern}\``).join("\n");
  const pkg = ctx.targetPackage;

  return `---
description: "Sandbox scope: restrict AI modifications to allowed paths only"
globs:
alwaysApply: true
---

# Sandbox Scope Rules

This workspace is an isolated AI task environment. All modifications must stay in scope.

Read \`.ai/task.md\` for the authoritative list of allowed and forbidden paths.

## Target${pkg ? `\n\nTarget package: **${pkg}**` : ""}

### Allowed Paths

${allowed || "- (see .ai/task.md)"}

### Forbidden Paths (NEVER modify)

${forbidden || "- tsconfig*\\n- .github/**"}

Additional forbidden patterns:
- Other workspace packages not listed in allowed paths
- Lock files (\`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`) unless explicitly required

## Hard Constraints (No exceptions)

- NEVER modify any \`tsconfig*.json\` file
- NEVER modify the \`"scripts"\` field in any \`package.json\`
- NEVER modify anything under \`.github/\`

## Enforcement

1. Before each edit, verify the file path is allowed
2. If file is in hard constraints, refuse unconditionally
3. If file is forbidden or outside allowed scope, stop and ask first
4. Never silently modify files outside scope
`;
}
