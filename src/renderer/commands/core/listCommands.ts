import type { WorkspaceGroupColor } from '@shared/workspaces/workspaceGroups'
import { registerCore } from '@/commands/coreCommand'
import { awaitsResume } from '@/lib/agents/autoResume'
import { type PaneAgentReport, paneAgentReport } from '@/lib/agents/paneAgent'
import { allPanes, splitTabOfPane } from '@/lib/layout/tree'
import type { SurfaceKind } from '@/lib/layout/types'
import { isKeptShell } from '@/lib/terminal/keptReattach'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { WorkspaceKind, WorkspaceState } from '@/stores/workspaces/workspaceTypes'

interface PaneListEntry extends PaneAgentReport {
  paneId: string
  workspaceId: string
  kind: SurfaceKind
  title: string
  cwd?: string
  filePath?: string
  splitTabId?: string
  splitTabName?: string
  hibernated?: true
  awaitingActivation?: true
}

interface WorkspaceListEntry {
  workspaceId: string
  name: string
  customName?: string
  kind: WorkspaceKind
  workDir: string
  state: WorkspaceState
  activePaneId?: string
  groupId?: string
}

interface WorkspaceGroupEntry {
  groupId: string
  name: string
  color?: WorkspaceGroupColor
  collapsed: boolean
  workspaceIds: string[]
}

export function registerListCommands(): void {
  registerCore<{ allWorkspaces?: boolean } | undefined, PaneListEntry[]>({
    id: 'pane.list',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: (args, ctx) => {
      const workspaceIds = args?.allWorkspaces
        ? useWorkspacesStore.getState().workspaces.map((s) => s.id)
        : ctx.activeWorkspaceId
          ? [ctx.activeWorkspaceId]
          : []
      const byWorkspace = useLayoutStore.getState().byWorkspace
      const result: PaneListEntry[] = []
      for (const workspaceId of workspaceIds) {
        const layout = byWorkspace[workspaceId]
        if (!layout) continue
        for (const pane of allPanes(layout.root)) {
          const splitTab = splitTabOfPane(layout.root, pane.id)
          result.push({
            paneId: pane.id,
            workspaceId,
            kind: pane.kind,
            title: pane.title,
            cwd: pane.cwd,
            ...(pane.kind === 'editor' && pane.filePath ? { filePath: pane.filePath } : {}),
            ...(pane.kind === 'terminal' ? paneAgentReport(pane.id, pane.resume) : {}),
            ...(pane.kind === 'agent' && pane.agentSessionId
              ? { agentSessionId: pane.agentSessionId }
              : {}),
            ...(splitTab ? { splitTabId: splitTab.id } : {}),
            ...(splitTab?.name ? { splitTabName: splitTab.name } : {}),
            ...(pane.hibernated ? { hibernated: true } : {}),
            ...(pane.kind === 'terminal' && awaitsResume(pane) && !isKeptShell(pane.id)
              ? { awaitingActivation: true }
              : {}),
          })
        }
      }
      return result
    },
  })

  registerCore<Record<string, never> | undefined, WorkspaceListEntry[]>({
    id: 'workspace.list',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: () =>
      useWorkspacesStore.getState().workspaces.map((s) => {
        const activePaneId = useLayoutStore.getState().byWorkspace[s.id]?.activePaneId
        return {
          workspaceId: s.id,
          name: s.name,
          ...(s.customName ? { customName: s.customName } : {}),
          kind: s.kind,
          workDir: s.workDir,
          state: s.state,
          ...(activePaneId ? { activePaneId } : {}),
          ...(s.groupId ? { groupId: s.groupId } : {}),
        }
      }),
  })

  registerCore<Record<string, never> | undefined, WorkspaceGroupEntry[]>({
    id: 'workspace.groups',
    hidden: true,
    capabilities: ['read-board'],
    target: 'none',
    run: () => {
      const { workspaces, groups } = useWorkspacesStore.getState()
      return groups.map((g) => ({
        groupId: g.id,
        name: g.name,
        ...(g.color ? { color: g.color } : {}),
        collapsed: Boolean(g.collapsed),
        workspaceIds: workspaces.filter((w) => w.groupId === g.id).map((w) => w.id),
      }))
    },
  })
}
