import type { SandboxContext } from "../types.js";

export function renderTaskMd(ctx: SandboxContext): string {
  const allowed = (ctx.allowedPaths || []).map((pattern) => `  - ${pattern}`).join("\n");
  const forbidden = (ctx.forbiddenPaths || []).map((pattern) => `  - ${pattern}`).join("\n");
  const verify = (ctx.verifyCommands || []).map((command) => `  - ${command}`).join("\n");

  return `---
intent: ${ctx.intent}
branch: ${ctx.branch}
baseBranch: ${ctx.baseBranch}
repoRoot: ${ctx.repoRoot}
taskDir: ${ctx.taskDir}
targetPackage: ${ctx.targetPackage || ""}
allowedPaths:
${allowed || '  - "**"'}
forbiddenPaths:
${forbidden || "  - tsconfig*\\n  - **/tsconfig*.json\\n  - .github/**"}
verifyCommands:
${verify || "  - pnpm lint\\n  - pnpm typecheck"}
uploadsDir: .ai/uploads
---

# AI Task: ${ctx.intent}

## Context

- **Branch**: \`${ctx.branch}\`
- **Base**: \`${ctx.baseBranch}\`
- **Target package**: ${ctx.targetPackage || "(entire repo)"}
- **Repo**: \`${ctx.repoRoot}\`

## Scope

Only modify files within the allowed paths listed in the frontmatter above.
If you need to change files outside the allowed scope, stop and ask first.

## Hard Constraints

- NEVER modify any \`tsconfig*.json\` file (no exceptions)
- NEVER modify \`"scripts"\` in any \`package.json\` (no exceptions)
- ALWAYS run the verify commands listed above before every git commit

## Getting Started

Read the root \`package.json\` to understand project structure and scripts${
    ctx.targetPackage ? ` for \`${ctx.targetPackage}\`` : ""
  }.

## Uploads

Reference files, screenshots, specs, and additional context go in \`.ai/uploads/\`.
Check that directory before starting work.

## Notes

(Add any additional context, constraints, or decisions here)
`;
}
