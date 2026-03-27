export type SandboxContext = {
  intent: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
  taskDir: string;
  targetPackage?: string;
  allowedPaths: string[];
  forbiddenPaths: string[];
  verifyCommands: string[];
  uploadsDir: string;
};

export type SandboxMode = "copy" | "worktree";

export type StartSandboxRequest = {
  repoId?: string;
  repoPath?: string;
  intent: string;
  targetPackage?: string;
  baseBranch?: string;
  openCursor?: boolean;
  installDeps?: boolean;
  mode?: SandboxMode;
};

export type SandboxResult = {
  repoId: string;
  repoRoot: string;
  workspacePath: string;
  branch: string;
  baseBranch: string;
  targetPackage?: string;
  verifyCommands: string[];
  mode: SandboxMode;
  createdFiles: string[];
};

export type RepoDescriptor = {
  id: string;
  path: string;
  defaultBranch?: string;
  label?: string;
};
