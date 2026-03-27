import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./utils.js";
import { renderTaskMd } from "./templates/task-md.js";
import { renderAskPlanBuild } from "./templates/ask-plan-build.js";
import { renderSandboxScope } from "./templates/ai-sandbox-scope.js";
import { renderChunkVerify } from "./templates/chunk-verify.js";
import type { SandboxContext } from "./types.js";

const PNPM_WORKTREE_HOIST_LINES = [
  "public-hoist-pattern[]=*babel*",
  "public-hoist-pattern[]=*vitejs*",
];

const EXCLUDE_HEADER = "# >>> ai-task scaffold (auto-managed)";
const EXCLUDE_FOOTER = "# <<< ai-task scaffold";
const SCAFFOLD_EXCLUDE_PATHS = [".ai/uploads/", ".vscode/settings.json", ".npmrc"];
const SKIP_WORKTREE_PATHS = [".vscode/settings.json", ".npmrc"];

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensurePnpmWorktreeNpmrc(taskDir: string): Promise<string | null> {
  const pnpmLockPath = path.join(taskDir, "pnpm-lock.yaml");
  if (!(await fileExists(pnpmLockPath))) {
    return null;
  }

  const npmrcPath = path.join(taskDir, ".npmrc");
  const additionHeader =
    "# Added by ai-task for pnpm worktree compatibility with Vite/Babel tooling.";
  const existing = await fs.readFile(npmrcPath, "utf-8").catch(() => "");
  const existingLines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missingLines = PNPM_WORKTREE_HOIST_LINES.filter((line) => !existingLines.has(line));

  if (missingLines.length === 0) {
    return null;
  }

  const prefix = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const nextContent = `${existing}${prefix}${additionHeader}\n${missingLines.join("\n")}\n`;
  await fs.writeFile(npmrcPath, nextContent, "utf-8");

  return existing.length === 0 ? ".npmrc" : ".npmrc (updated)";
}

function buildFilesExclude(): Record<string, boolean> {
  return {
    node_modules: true,
    "**/node_modules": true,
    dist: true,
    "**/dist": true,
    build: true,
    "**/build": true,
    ".git": true,
    ".idea": true,
    ".DS_Store": true,
    "Thumbs.db": true,
  };
}

export async function scaffold(taskDir: string, ctx: SandboxContext): Promise<string[]> {
  const created: string[] = [];

  const aiDir = path.join(taskDir, ".ai");
  const uploadsDir = path.join(taskDir, ".ai", "uploads");
  const rulesDir = path.join(taskDir, ".cursor", "rules");
  const plansDir = path.join(taskDir, ".cursor", "plans");
  const vscodeDir = path.join(taskDir, ".vscode");

  await ensureDir(aiDir);
  await ensureDir(uploadsDir);
  await ensureDir(rulesDir);
  await ensureDir(plansDir);
  await ensureDir(vscodeDir);

  await fs.writeFile(path.join(aiDir, "task.md"), renderTaskMd(ctx), "utf-8");
  created.push(".ai/task.md");

  await fs.writeFile(path.join(uploadsDir, ".gitkeep"), "", "utf-8");
  created.push(".ai/uploads/");

  await fs.writeFile(path.join(rulesDir, "ask-plan-build.mdc"), renderAskPlanBuild(), "utf-8");
  created.push(".cursor/rules/ask-plan-build.mdc");

  await fs.writeFile(
    path.join(rulesDir, "ai-sandbox-scope.mdc"),
    renderSandboxScope(ctx),
    "utf-8",
  );
  created.push(".cursor/rules/ai-sandbox-scope.mdc");

  await fs.writeFile(path.join(rulesDir, "chunk-verify.mdc"), renderChunkVerify(ctx), "utf-8");
  created.push(".cursor/rules/chunk-verify.mdc");

  const vscodeSettings = { "files.exclude": buildFilesExclude() };
  await fs.writeFile(
    path.join(vscodeDir, "settings.json"),
    `${JSON.stringify(vscodeSettings, null, 2)}\n`,
    "utf-8",
  );
  created.push(".vscode/settings.json");

  const npmrcEntry = await ensurePnpmWorktreeNpmrc(taskDir);
  if (npmrcEntry) {
    created.push(npmrcEntry);
  }

  await ensureGitExclude(taskDir);
  await skipWorktreeTracked(taskDir);

  return created;
}

async function ensureGitExclude(taskDir: string): Promise<void> {
  const excludePath = path.join(taskDir, ".git", "info", "exclude");
  await ensureDir(path.dirname(excludePath));
  const existing = await fs.readFile(excludePath, "utf-8").catch(() => "");
  if (existing.includes(EXCLUDE_HEADER)) {
    return;
  }

  const block = ["", EXCLUDE_HEADER, ...SCAFFOLD_EXCLUDE_PATHS, EXCLUDE_FOOTER, ""].join("\n");
  await fs.writeFile(excludePath, `${existing.trimEnd()}\n${block}`, "utf-8");
}

export async function removeGitExclude(taskDir: string): Promise<void> {
  const excludePath = path.join(taskDir, ".git", "info", "exclude");
  let content: string;
  try {
    content = await fs.readFile(excludePath, "utf-8");
  } catch {
    return;
  }
  const re = new RegExp(
    `\\n?${EXCLUDE_HEADER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${EXCLUDE_FOOTER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`,
  );
  await fs.writeFile(excludePath, content.replace(re, "\n"), "utf-8");
}

async function isTracked(taskDir: string, filePath: string): Promise<boolean> {
  try {
    await exec("git", ["ls-files", "--error-unmatch", filePath], { cwd: taskDir });
    return true;
  } catch {
    return false;
  }
}

async function skipWorktreeTracked(taskDir: string): Promise<void> {
  for (const filePath of SKIP_WORKTREE_PATHS) {
    if (await isTracked(taskDir, filePath)) {
      await exec("git", ["update-index", "--skip-worktree", filePath], { cwd: taskDir });
    }
  }
}

export async function unskipWorktreeTracked(taskDir: string): Promise<void> {
  for (const filePath of SKIP_WORKTREE_PATHS) {
    try {
      await exec("git", ["update-index", "--no-skip-worktree", filePath], { cwd: taskDir });
    } catch {
      // ignore
    }
  }
}
