import { spawn } from "node:child_process";

export type ExecOptions = {
  cwd?: string;
  shell?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
};

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function normalizePath(input: string): string {
  return input.replace(/\\/g, "/");
}

export function parseBool(input: unknown, fallback = false): boolean {
  if (typeof input === "boolean") {
    return input;
  }
  if (typeof input !== "string") {
    return fallback;
  }
  const normalized = input.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

export async function exec(command: string, args: string[] = [], opts: ExecOptions = {}): Promise<string> {
  const result = await execWithResult(command, args, opts);
  return result.stdout.trim();
}

export function execWithResult(
  command: string,
  args: string[] = [],
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      shell: opts.shell ?? false,
      cwd: opts.cwd,
      env: opts.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(
          `${command} ${args.join(" ")} exited with ${String(code)}${
            stderr ? `\n${stderr}` : ""
          }`,
        ) as Error & { code?: number; stderr?: string; stdout?: string };
        error.code = code ?? undefined;
        error.stderr = stderr;
        error.stdout = stdout;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.on("error", reject);
  });
}
