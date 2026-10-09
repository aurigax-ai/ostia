import type { PaneEntry, WorkspaceEntry } from '../panes/paneList'
import { expandHome } from '../platform/pathGuard'

export class WorkspaceCwds {
  private lastTerminal = new Map<string, string>()

  resolve(workspaces: WorkspaceEntry[], panes: PaneEntry[]): Map<string, string> {
    const out = new Map<string, string>()
    const live = new Set(workspaces.map((s) => s.workspaceId))
    for (const id of [...this.lastTerminal.keys()]) if (!live.has(id)) this.lastTerminal.delete(id)
    for (const workspace of workspaces) {
      const own = panes.filter((p) => p.workspaceId === workspace.workspaceId)
      const active = own.find((p) => p.paneId === workspace.activePaneId)
      if (active?.kind === 'terminal' && active.cwd) {
        this.lastTerminal.set(workspace.workspaceId, active.cwd)
      }
      const cwd =
        active?.cwd ||
        this.lastTerminal.get(workspace.workspaceId) ||
        own.find((p) => p.kind === 'terminal' && p.cwd)?.cwd ||
        workspace.workDir
      if (cwd) out.set(workspace.workspaceId, expandHome(cwd))
    }
    return out
  }
}
