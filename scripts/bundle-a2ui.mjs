import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hashFile = path.join(rootDir, "src", "canvas-host", "a2ui", ".bundle.hash");
const outputFile = path.join(rootDir, "src", "canvas-host", "a2ui", "a2ui.bundle.js");
const a2uiRendererDir = path.join(rootDir, "vendor", "a2ui", "renderers", "lit");
const a2uiAppDir = path.join(rootDir, "apps", "shared", "OpenClawKit", "Tools", "CanvasA2UI");
const inputPaths = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "pnpm-lock.yaml"),
  a2uiRendererDir,
  a2uiAppDir,
];

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function quoteWindowsArg(arg) {
  if (arg.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function fail(message) {
  console.error(message);
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(entryPath, files) {
  const stat = await fs.stat(entryPath);
  if (stat.isDirectory()) {
    const entries = await fs.readdir(entryPath);
    for (const entry of entries) {
      await collectFiles(path.join(entryPath, entry), files);
    }
    return;
  }
  files.push(entryPath);
}

function normalizePath(targetPath) {
  return targetPath.split(path.sep).join("/");
}

async function computeHash(pathsToHash) {
  const files = [];
  for (const entryPath of pathsToHash) {
    await collectFiles(entryPath, files);
  }

  files.sort((left, right) => normalizePath(left).localeCompare(normalizePath(right)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    hash.update(normalizePath(path.relative(rootDir, filePath)));
    hash.update("\0");
    hash.update(await fs.readFile(filePath));
    hash.update("\0");
  }

  return hash.digest("hex");
}

function runCommand(command, args) {
  const resolvedCommand = process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
  const result =
    process.platform === "win32" && resolvedCommand.toLowerCase().endsWith(".cmd")
      ? spawnSync(
          process.env.ComSpec ?? "cmd.exe",
          [
            "/d",
            "/s",
            "/c",
            `${resolvedCommand} ${args.map((arg) => quoteWindowsArg(arg)).join(" ")}`,
          ],
          {
            cwd: rootDir,
            stdio: "inherit",
          },
        )
      : spawnSync(resolvedCommand, args, {
          cwd: rootDir,
          stdio: "inherit",
        });

  if (result.error) {
    fail(`Failed to start ${command}: ${formatError(result.error)}`);
  }

  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function main() {
  const sourcesMissing = !(await pathExists(a2uiRendererDir)) || !(await pathExists(a2uiAppDir));
  if (sourcesMissing) {
    if (await pathExists(outputFile)) {
      console.log("A2UI sources missing; keeping prebuilt bundle.");
      return;
    }
    fail(`A2UI sources missing and no prebuilt bundle found at: ${outputFile}`);
  }

  const currentHash = await computeHash(inputPaths);
  if ((await pathExists(hashFile)) && (await pathExists(outputFile))) {
    const previousHash = (await fs.readFile(hashFile, "utf8")).trim();
    if (previousHash === currentHash) {
      console.log("A2UI bundle up to date; skipping.");
      return;
    }
  }

  const typescriptCli = path.join(rootDir, "node_modules", "typescript", "bin", "tsc");
  runCommand(process.execPath, [typescriptCli, "-p", path.join(a2uiRendererDir, "tsconfig.json")]);

  const rolldownRootBin = path.join(rootDir, "node_modules", "rolldown", "bin", "cli.mjs");
  const rolldownConfig = path.join(a2uiAppDir, "rolldown.config.mjs");

  if (await pathExists(rolldownRootBin)) {
    runCommand(process.execPath, [rolldownRootBin, "-c", rolldownConfig]);
  } else {
    runCommand("pnpm", ["-s", "dlx", "rolldown", "-c", rolldownConfig]);
  }

  await fs.writeFile(hashFile, `${currentHash}\n`);
}

try {
  await main();
} catch (error) {
  fail(formatError(error));
}
