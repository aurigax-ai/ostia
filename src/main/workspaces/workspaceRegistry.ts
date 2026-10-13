const workspaceWorkDirs = new Map<string, string>()
const workspaceWindows = new Map<string, string>()

export function setWorkspaceWorkDir(workspaceId: string, workDir: string, windowId?: string): void {
  workspaceWorkDirs.set(workspaceId, workDir)
  if (windowId) workspaceWindows.set(workspaceId, windowId)
}

export function removeWorkspace(workspaceId: string): void {
  workspaceWorkDirs.delete(workspaceId)
  workspaceWindows.delete(workspaceId)
}

export function workDirForWorkspace(workspaceId?: string): string | undefined {
  return workspaceId ? workspaceWorkDirs.get(workspaceId) : undefined
}

export function windowForWorkspace(workspaceId: string): string | undefined {
  return workspaceWindows.get(workspaceId)
}
