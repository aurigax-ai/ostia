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
}

export interface WorkspaceEntry {
  workspaceId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
}

export interface PaneEntry {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
  pid?: number
}

export interface PaneListDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  ptyPid: (paneId: string) => number | undefined
}

const GLOBAL_TARGET: CommandTarget = { workspaceId: '', paneId: null }

export async function listPanes(deps: PaneListDeps): Promise<PaneEntry[]> {
  const res = await deps.execCommand(GLOBAL_TARGET, 'pane.list', { allWorkspaces: true })
  if (!res.ok) return []
  const panes = (res.result as RendererPaneEntry[] | undefined) ?? []
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
      running: state?.running ?? false,
      blockCount: state?.blockCount ?? 0,
      lastExitCode: state?.lastExitCode,
      ...(pid ? { pid } : {}),
    })
  }
  return mapped
}

export async function listWorkspaces(
  deps: Pick<PaneListDeps, 'execCommand'>,
): Promise<WorkspaceEntry[]> {
  const res = await deps.execCommand(GLOBAL_TARGET, 'workspace.list', {})
  if (!res.ok) return []
  const workspaces = (res.result as WorkspaceEntry[] | undefined) ?? []
  return workspaces.map(({ activePaneId, ...workspace }) => {
    const external = activePaneId ? getByPaneId(activePaneId)?.externalId : undefined
    return external ? { ...workspace, activePaneId: external } : workspace
  })
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
}
