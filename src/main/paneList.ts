import type { Capability } from '../shared/capabilities'
import type { CommandResult, CommandTarget, TerminalStateSnapshot } from '../shared/types'
import { registerControlMethod } from './controlServer'
import { getByPaneId } from './idRegistry'

interface RendererPaneEntry {
  paneId: string
  sessionId: string
  kind: string
  title: string
  cwd?: string
}

export interface SessionEntry {
  sessionId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
}

export interface PaneEntry {
  paneId: string
  sessionId: string
  kind: string
  title: string
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
}

export interface PaneListDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
}

const GLOBAL_TARGET: CommandTarget = { sessionId: '', paneId: null }

export async function listPanes(deps: PaneListDeps): Promise<PaneEntry[]> {
  const res = await deps.execCommand(GLOBAL_TARGET, 'pane.list', { allSessions: true })
  if (!res.ok) return []
  const panes = (res.result as RendererPaneEntry[] | undefined) ?? []
  const mapped: PaneEntry[] = []
  for (const p of panes) {
    const identity = getByPaneId(p.paneId)
    if (!identity) continue
    const state = deps.getTerminalState(p.paneId)
    mapped.push({
      paneId: identity.externalId,
      sessionId: p.sessionId,
      kind: p.kind,
      title: p.title,
      cwd: state?.cwd ?? p.cwd,
      running: state?.running ?? false,
      blockCount: state?.blockCount ?? 0,
      lastExitCode: state?.lastExitCode,
    })
  }
  return mapped
}

export async function listSessions(
  deps: Pick<PaneListDeps, 'execCommand'>,
): Promise<SessionEntry[]> {
  const res = await deps.execCommand(GLOBAL_TARGET, 'session.list', {})
  if (!res.ok) return []
  const sessions = (res.result as SessionEntry[] | undefined) ?? []
  return sessions.map(({ activePaneId, ...session }) => {
    const external = activePaneId ? getByPaneId(activePaneId)?.externalId : undefined
    return external ? { ...session, activePaneId: external } : session
  })
}

const READ_BOARD: Capability = 'read-board'

export function registerPaneListMethods(deps: PaneListDeps): void {
  registerControlMethod('pane.list', {
    cap: READ_BOARD,
    callers: 'all',
    handler: () => listPanes(deps),
  })
  registerControlMethod('session.list', {
    cap: READ_BOARD,
    callers: 'all',
    handler: () => listSessions(deps),
  })
}
