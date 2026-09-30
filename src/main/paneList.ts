import type { Capability } from '../shared/capabilities'
import type { CommandResult, CommandTarget, TerminalStateSnapshot } from '../shared/types'
import { registerControlMethod } from './controlServer'
import { getByPaneId } from './idRegistry'

interface RendererPaneEntry {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  cwd?: string
  filePath?: string
}

export interface WorkspaceEntry {
  workspaceId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
  groupId?: string
}

export interface WorkspaceGroupEntry {
  groupId: string
  name: string
  color?: string
  collapsed: boolean
  workspaceIds: string[]
}

export interface PaneEntry {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  cwd?: string
  filePath?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
  pid?: number
}

export interface PaneListDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  ptyPid: (paneId: string) => number | undefined
  windowIds: () => string[]
}

async function listFromEveryWindow<T>(
  deps: Pick<PaneListDeps, 'execCommand' | 'windowIds'>,
  id: string,
  args: unknown,
): Promise<T[]> {
  const results = await Promise.all(
    deps
      .windowIds()
      .map((windowId) => deps.execCommand({ windowId, workspaceId: '', paneId: null }, id, args)),
  )
  return results.flatMap((res) => (res.ok && Array.isArray(res.result) ? (res.result as T[]) : []))
}

export async function listPanes(deps: PaneListDeps): Promise<PaneEntry[]> {
  const panes = await listFromEveryWindow<RendererPaneEntry>(deps, 'pane.list', {
    allWorkspaces: true,
  })
  const mapped: PaneEntry[] = []
  for (const p of panes) {
    const identity = getByPaneId(p.paneId)
    if (!identity) continue
    const state = deps.getTerminalState(p.paneId)
    const pid = p.kind === 'terminal' ? deps.ptyPid(p.paneId) : undefined
    mapped.push({
      paneId: identity.externalId,
      workspaceId: p.workspaceId,
      kind: p.kind,
      title: p.title,
      cwd: state?.cwd ?? p.cwd,
      ...(p.filePath ? { filePath: p.filePath } : {}),
      running: state?.running ?? false,
      blockCount: state?.blockCount ?? 0,
      lastExitCode: state?.lastExitCode,
      ...(pid ? { pid } : {}),
    })
  }
  return mapped
}

export async function listWorkspaces(
  deps: Pick<PaneListDeps, 'execCommand' | 'windowIds'>,
): Promise<WorkspaceEntry[]> {
  const workspaces = await listFromEveryWindow<WorkspaceEntry>(deps, 'workspace.list', {})
  return workspaces.map(({ activePaneId, ...workspace }) => {
    const external = activePaneId ? getByPaneId(activePaneId)?.externalId : undefined
    return external ? { ...workspace, activePaneId: external } : workspace
  })
}

export async function listWorkspaceGroups(
  deps: Pick<PaneListDeps, 'execCommand' | 'windowIds'>,
): Promise<WorkspaceGroupEntry[]> {
  return listFromEveryWindow<WorkspaceGroupEntry>(deps, 'workspace.groups', {})
}

const READ_BOARD: Capability = 'read-board'

export function registerPaneListMethods(deps: PaneListDeps): void {
  registerControlMethod('pane.list', {
    cap: READ_BOARD,
    callers: 'all',
    handler: () => listPanes(deps),
  })
  registerControlMethod('workspace.list', {
    cap: READ_BOARD,
    callers: 'all',
    handler: () => listWorkspaces(deps),
  })
  registerControlMethod('workspace.groups', {
    cap: READ_BOARD,
    callers: 'all',
    handler: () => listWorkspaceGroups(deps),
  })
}
