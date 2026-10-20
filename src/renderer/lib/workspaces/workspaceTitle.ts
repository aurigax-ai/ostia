export function workspaceTitle(workspace: { name: string; customName?: string }): string {
  return workspace.customName ?? workspace.name
}
