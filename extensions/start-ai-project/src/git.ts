import fs from "node:fs/promises";
import path from "node:path";
import { exec } from "./utils.js";

const COPY_SKIP = new Set(["node_modules", ".next", ".turbo", ".cache"]);

export async function getRepoRoot(cwd: string): Promise<string> {
  try {
    const root = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
    return root.replace(/\//g, path.sep);
  } catch {
    throw new Error(`Not inside a git repository: ${cwd}`);
  }
}

export async function getCurrentBranch(cwd: string): Promise<string> {
  return exec("git", ["branch", "--show-current"], { cwd });
}

export async function getDefaultBranch(cwd: string): Promise<string> {
  const currentBranch = (await getCurrentBranch(cwd)).trim();
  if (currentBranch) {
    return currentBranch;
  }

  for (const candidate of ["main", "master"]) {
    try {
      await exec("git", ["rev-parse", "--verify", candidate], { cwd });
      return candidate;
    } catch {
      continue;
    }
  }

  throw new Error("Unable to determine a base branch. Specify one explicitly.");
}

export async function addWorktree(
  repoRoot: string,
  taskDir: string,
  branch: string,
  baseBranch: string,
): Promise<void> {
  await exec("git", ["worktree", "add", "-b", branch, taskDir, baseBranch], {
    cwd: repoRoot,
  });
}

export async function copyRepo(repoRoot: string, taskDir: string): Promise<void> {
  await fs.cp(repoRoot, taskDir, {
    recursive: true,
    filter: (src) => !COPY_SKIP.has(path.basename(src)),
  });
}

export async function checkoutNewBranch(cwd: string, branchName: string): Promise<void> {
  await exec("git", ["checkout", "-b", branchName], { cwd });
}

export async function listPackages(repoRoot: string): Promise<string[]> {
  const packagesDir = path.join(repoRoot, "packages");
  try {
    const entries = await fs.readdir(packagesDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export async function detectVerifyCommands(repoRoot: string, targetPackage?: string): Promise<string[]> {
  const commands: string[] = [];

  const rootPkgPath = path.join(repoRoot, "package.json");
  try {
    const raw = await fs.readFile(rootPkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const key of ["lint", "type-check", "typecheck", "tsc", "check"]) {
      if (scripts[key]) {
        commands.push(`pnpm ${key}`);
      }
    }
  } catch {
    // ignore
  }

  if (!targetPackage) {
    return commands;
  }

  const pkgPath = path.join(repoRoot, "packages", targetPackage, "package.json");
  try {
    const raw = await fs.readFile(pkgPath, "utf-8");
    const pkg = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    for (const key of ["lint", "type-check", "typecheck", "tsc", "check"]) {
      if (!scripts[key]) {
        continue;
      }
      const command = `pnpm --filter ${pkg.name || targetPackage} ${key}`;
      if (!commands.includes(command)) {
        commands.push(command);
      }
    }
  } catch {
    // ignore
  }

  return commands;
}
