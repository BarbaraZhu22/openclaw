import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginConfigSchema } from "../runtime-api.js";
import type { RepoDescriptor } from "./types.js";

export type StartAiProjectPluginConfig = {
  repoListPath?: string;
  reposRoot?: string;
  sandboxRoot?: string;
  groupRepoFilters?: Record<string, string[]>;
};

export type ResolvedStartAiProjectPluginConfig = {
  repoListPath?: string;
  reposRoot?: string;
  sandboxRoot?: string;
  groupRepoFilters: Record<string, string[]>;
};

export function createStartAiProjectPluginConfigSchema(): OpenClawPluginConfigSchema {
  return {
    validate(value: unknown) {
      if (value == null) {
        return { ok: true };
      }
      if (typeof value !== "object" || Array.isArray(value)) {
        return { ok: false, errors: ["start-ai-project config must be an object"] };
      }
      const cfg = value as Record<string, unknown>;
      const errors: string[] = [];
      for (const key of ["repoListPath", "reposRoot", "sandboxRoot"]) {
        if (cfg[key] != null && typeof cfg[key] !== "string") {
          errors.push(`${key} must be a string`);
        }
      }
      if (cfg.groupRepoFilters != null) {
        if (typeof cfg.groupRepoFilters !== "object" || Array.isArray(cfg.groupRepoFilters)) {
          errors.push("groupRepoFilters must be an object mapping group ids to repo id arrays");
        } else {
          for (const [groupId, repoIds] of Object.entries(cfg.groupRepoFilters)) {
            if (!groupId.trim()) {
              errors.push("groupRepoFilters keys must be non-empty strings");
              continue;
            }
            if (!Array.isArray(repoIds) || repoIds.some((repoId) => typeof repoId !== "string")) {
              errors.push(`groupRepoFilters.${groupId} must be an array of repo ids`);
            }
          }
        }
      }
      return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repoListPath: { type: "string" },
        reposRoot: { type: "string" },
        sandboxRoot: { type: "string" },
        groupRepoFilters: {
          type: "object",
          additionalProperties: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
  };
}

export function resolvePluginConfig(params: {
  pluginConfig: unknown;
  resolvePath: (input: string) => string;
}): ResolvedStartAiProjectPluginConfig {
  const raw = (params.pluginConfig ?? {}) as StartAiProjectPluginConfig;
  return {
    repoListPath: raw.repoListPath ? params.resolvePath(raw.repoListPath) : undefined,
    reposRoot: raw.reposRoot ? params.resolvePath(raw.reposRoot) : undefined,
    sandboxRoot: raw.sandboxRoot ? params.resolvePath(raw.sandboxRoot) : undefined,
    groupRepoFilters: normalizeGroupRepoFilters(raw.groupRepoFilters),
  };
}

function normalizeGroupRepoFilters(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string[]> = {};
  for (const [groupId, repoIds] of Object.entries(value)) {
    const normalizedGroupId = groupId.trim();
    if (!normalizedGroupId || !Array.isArray(repoIds)) {
      continue;
    }
    const normalizedRepoIds = repoIds
      .filter((repoId): repoId is string => typeof repoId === "string")
      .map((repoId) => repoId.trim())
      .filter(Boolean);
    if (normalizedRepoIds.length > 0) {
      result[normalizedGroupId] = normalizedRepoIds;
    }
  }
  return result;
}

export async function loadRepoDescriptors(config: ResolvedStartAiProjectPluginConfig): Promise<RepoDescriptor[]> {
  if (!config.repoListPath) {
    return [];
  }
  const content = await fs.readFile(config.repoListPath, "utf-8");
  const ext = path.extname(config.repoListPath).toLowerCase();
  if (ext === ".json") {
    return normalizeJsonRepoList(content, config.reposRoot);
  }
  return normalizeMarkdownRepoList(content, config.reposRoot);
}

function normalizeRepoPath(repoPath: string, reposRoot?: string): string {
  if (!repoPath) {
    return repoPath;
  }
  if (path.isAbsolute(repoPath)) {
    return repoPath;
  }
  if (reposRoot) {
    return path.resolve(reposRoot, repoPath);
  }
  return path.resolve(repoPath);
}

function normalizeJsonRepoList(content: string, reposRoot?: string): RepoDescriptor[] {
  const parsed = JSON.parse(content) as unknown;
  let entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.repos)) {
      entries = obj.repos;
    } else {
      entries = Object.entries(obj).map(([id, repoPath]) => ({ id, path: repoPath }));
    }
  }

  const repos: RepoDescriptor[] = [];
  for (const entry of entries) {
    if (!entry) {
      continue;
    }
    if (typeof entry === "string") {
      repos.push({ id: path.basename(entry), path: normalizeRepoPath(entry, reposRoot) });
      continue;
    }
    if (typeof entry === "object" && !Array.isArray(entry)) {
      const row = entry as Record<string, unknown>;
      const id = String(row.id ?? row.name ?? row.repo ?? "").trim();
      const repoPath = String(row.path ?? row.repoPath ?? row.dir ?? "").trim();
      if (!id || !repoPath) {
        continue;
      }
      repos.push({
        id,
        label: typeof row.label === "string" ? row.label : undefined,
        defaultBranch: typeof row.defaultBranch === "string" ? row.defaultBranch : undefined,
        path: normalizeRepoPath(repoPath, reposRoot),
      });
    }
  }
  return dedupeRepos(repos);
}

function normalizeMarkdownRepoList(content: string, reposRoot?: string): RepoDescriptor[] {
  const repos: RepoDescriptor[] = [];
  const lines = content.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const mdLink = line.match(/^\s*-\s*\[([^\]]+)\]\(([^)]+)\)\s*$/);
    if (mdLink) {
      repos.push({
        id: mdLink[1].trim(),
        path: normalizeRepoPath(mdLink[2].trim(), reposRoot),
      });
      continue;
    }

    const pipeLine = line.match(/^\s*-\s*([^|]+)\|\s*(.+)\s*$/);
    if (pipeLine) {
      repos.push({
        id: pipeLine[1].trim(),
        path: normalizeRepoPath(pipeLine[2].trim(), reposRoot),
      });
      continue;
    }

    const colonLine = line.match(/^\s*-?\s*([\w.-]+)\s*:\s*(.+)\s*$/);
    if (colonLine) {
      repos.push({
        id: colonLine[1].trim(),
        path: normalizeRepoPath(colonLine[2].trim(), reposRoot),
      });
      continue;
    }
  }
  return dedupeRepos(repos);
}

function dedupeRepos(repos: RepoDescriptor[]): RepoDescriptor[] {
  const seen = new Set<string>();
  const result: RepoDescriptor[] = [];
  for (const repo of repos) {
    if (!repo.id || !repo.path) {
      continue;
    }
    if (seen.has(repo.id)) {
      continue;
    }
    seen.add(repo.id);
    result.push(repo);
  }
  return result;
}
