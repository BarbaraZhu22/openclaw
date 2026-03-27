export function renderAskPlanBuild(): string {
  return `---
description: "Ask-Plan-Build workflow: activate when user says /apb, ask-plan-build, or APB"
globs:
alwaysApply: false
---

# Ask-Plan-Build Workflow

Follow this 3-phase workflow strictly. Never skip a phase.

Before starting, read \`.ai/task.md\` to understand context, scope, and constraints.
Also check \`.ai/uploads/\` for any reference files the user has provided.

## Phase 1: ASK (Clarification Loop)

1. Read \`.ai/task.md\` for task intent and scope
2. Check \`.ai/uploads/\` for reference material
3. Ask 3-5 targeted questions covering:
   - Scope
   - Constraints
   - Edge cases
   - Dependencies
   - Acceptance criteria
4. Stop and wait for the user's answers
5. Summarize understanding and ask:
   > "Does this look correct? Should I proceed to Plan, or do you have corrections?"
6. If corrected, ask follow-up questions
7. Repeat until the user explicitly confirms

Do not move to Phase 2 until the user confirms.

## Phase 2: PLAN

1. Design an implementation plan with 4-10 tasks
2. Save the plan to \`.cursor/plans/\` as \`.plan.md\` with frontmatter todos
3. Add a \`## Details\` section for rationale
4. Present plan and ask:
   > "Here is the plan. Ready to build, or do you want changes?"
5. Stop and wait for confirmation

Do not move to Phase 3 until the user confirms.

## Phase 3: BUILD

1. Execute task-by-task
2. Keep todo state in sync
3. Run verify commands from \`.ai/task.md\` after each chunk
4. Summarize files changed, key decisions, and verification items
5. Ask if any follow-up adjustments are needed

## Rules

- Each phase is a gate and requires explicit user confirmation
- Keep questions concise and numbered
- If user asks to skip ASK, still confirm scope before building
- Save the plan before starting build
`;
}
