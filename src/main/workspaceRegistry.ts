const workspaceWorkDirs = new Map<string, string>()

export function setWorkspaceWorkDir(workspaceId: string, workDir: string): void {
  workspaceWorkDirs.set(workspaceId, workDir)
}

export function removeWorkspace(workspaceId: string): void {
  workspaceWorkDirs.delete(workspaceId)
}

export function workDirForWorkspace(workspaceId?: string): string | undefined {
  return workspaceId ? workspaceWorkDirs.get(workspaceId) : undefined
}
