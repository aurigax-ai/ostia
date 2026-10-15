export type WorkspaceLookup = (workspaceId: string) => { workDir: string } | undefined

let lookup: WorkspaceLookup = () => undefined

export function setWorkspaceLookup(next: WorkspaceLookup): void {
  lookup = next
}

export function workspaceOf(workspaceId: string): ReturnType<WorkspaceLookup> {
  return lookup(workspaceId)
}

export function workDirOf(workspaceId: string): string | undefined {
  return workspaceOf(workspaceId)?.workDir
}
