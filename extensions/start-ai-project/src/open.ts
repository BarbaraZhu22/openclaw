import { exec } from "./utils.js";

export async function hasCursorCli(): Promise<boolean> {
  try {
    await exec("cursor", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function openCursorWorkspace(dir: string): Promise<boolean> {
  const available = await hasCursorCli();
  if (!available) {
    return false;
  }
  await exec("cursor", ["."], { cwd: dir });
  return true;
}
