import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { isResumableAgent } from '../../shared/agents/agentResume'
import type { CommandResult, CommandTarget } from '../../shared/control/commands'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { Reach } from '../approvals/reach'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import { getByPaneId, resolveExternal } from '../control/idRegistry'
import { nameOf } from './paneNames'

interface PaneAgentFields {
  agent?: string
  agentSessionId?: string
  agentState?: string
  agentMessage?: string
}

interface RendererPaneEntry extends PaneAgentFields {
  paneId: string
  workspaceId: string
  kind: string
  title: string
  cwd?: string
  filePath?: string
  splitTabId?: string
  splitTabName?: string
  hibernated?: unknown
  awaitingActivation?: unknown
}

export interface WorkspaceEntry {
  workspaceId: string
  name: string
  kind: string
  workDir: string
  state: string
  activePaneId?: string
  groupId?: string
  sandboxed?: boolean
}

export interface WorkspaceGroupEntry {
  groupId: string
  name: string
  color?: string
  collapsed: boolean
  workspaceIds: string[]
}

export interface PaneEntry extends PaneAgentFields {
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
  splitTabId?: string
  splitTabName?: string
  hibernated?: true
  waking?: true
  awaitingActivation?: true
  startError?: string
  agentSessionConflict?: string[]
  process?: PaneProcessStatus
  name?: string
  description?: string
}

interface PaneProcessStatus {
  id: string
  status: string
  start?: string
}

export interface PaneListDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  ptyPid: (paneId: string) => number | undefined
  windowIds: () => string[]
  waking: (paneId: string) => boolean
  startError?: (paneId: string) => string | undefined
  processOf?: (paneId: string) => PaneProcessStatus | undefined
  reach?: Pick<Reach, 'scriptReach'>
  isSandboxed?: (workspaceId: string) => boolean
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

function agentFields(p: RendererPaneEntry): PaneAgentFields {
  const fields: PaneAgentFields = {}
  if (typeof p.agent === 'string') fields.agent = p.agent
  if (typeof p.agentSessionId === 'string') fields.agentSessionId = p.agentSessionId
  if (typeof p.agentState === 'string') fields.agentState = p.agentState
  if (typeof p.agentMessage === 'string') fields.agentMessage = p.agentMessage
  return fields
}

function liveSessionKey(p: PaneEntry): string | null {
  return isResumableAgent(p.agent) && p.agentSessionId ? `${p.agent}:${p.agentSessionId}` : null
}

export function markSessionConflicts(panes: PaneEntry[]): PaneEntry[] {
  const holders = new Map<string, string[]>()
  for (const p of panes) {
    const key = liveSessionKey(p)
    if (key) holders.set(key, [...(holders.get(key) ?? []), p.paneId])
  }
  return panes.map((p) => {
    const key = liveSessionKey(p)
    const others = key ? (holders.get(key) ?? []).filter((id) => id !== p.paneId) : []
    return others.length > 0 ? { ...p, agentSessionConflict: others } : p
  })
}

export function liveSessionHolder(panes: PaneEntry[], paneId: string): PaneEntry | null {
  const id = panes.find((p) => p.paneId === paneId)?.agentSessionId
  if (!id) return null
  return (
    panes.find(
      (p) => p.paneId !== paneId && p.agentSessionId === id && isResumableAgent(p.agent),
    ) ?? null
  )
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
    const run = deps.processOf?.(p.paneId)
    const startError = pid || p.hibernated === true ? undefined : deps.startError?.(p.paneId)
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
      ...(p.hibernated === true ? { hibernated: true } : {}),
      ...(deps.waking(p.paneId) ? { waking: true } : {}),
      ...(p.awaitingActivation === true ? { awaitingActivation: true } : {}),
      ...(startError ? { startError } : {}),
      ...agentFields(p),
      ...(typeof p.splitTabId === 'string' ? { splitTabId: p.splitTabId } : {}),
      ...(typeof p.splitTabName === 'string' ? { splitTabName: p.splitTabName } : {}),
      ...(run ? { process: run } : {}),
    })
  }
  return markSessionConflicts(mapped)
}

export async function listWorkspaces(
  deps: Pick<PaneListDeps, 'execCommand' | 'windowIds' | 'isSandboxed'>,
): Promise<WorkspaceEntry[]> {
  const workspaces = await listFromEveryWindow<WorkspaceEntry>(deps, 'workspace.list', {})
  return workspaces.map(({ activePaneId, ...workspace }) => {
    const external = activePaneId ? getByPaneId(activePaneId)?.externalId : undefined
    const marked = deps.isSandboxed?.(workspace.workspaceId)
      ? { ...workspace, sandboxed: true }
      : workspace
    return external ? { ...marked, activePaneId: external } : marked
  })
}

export async function listWorkspaceGroups(
  deps: Pick<PaneListDeps, 'execCommand' | 'windowIds'>,
): Promise<WorkspaceGroupEntry[]> {
  return listFromEveryWindow<WorkspaceGroupEntry>(deps, 'workspace.groups', {})
}

const READ_BOARD: Capability = 'read-board'

function withBusName(pane: PaneEntry): PaneEntry {
  const identity = resolveExternal(pane.paneId)
  const held = identity?.kind === 'pane' ? nameOf(identity.paneId) : undefined
  return held
    ? { ...pane, name: held.name, ...(held.desc ? { description: held.desc } : {}) }
    : pane
}

export function registerPaneListMethods(deps: PaneListDeps): void {
  const scoped = async (ctx: ControlMethodContext) => (await deps.reach?.scriptReach(ctx)) ?? null

  registerControlMethod('pane.list', {
    cap: READ_BOARD,
    callers: 'all',
    scripts: true,
    handler: async (_params, ctx) => {
      const [scope, listed] = await Promise.all([scoped(ctx), listPanes(deps)])
      const panes = ctx.identity.kind === 'extension' ? listed : listed.map(withBusName)
      return scope ? panes.filter((p) => scope.covers(p.workspaceId)) : panes
    },
  })
  registerControlMethod('workspace.list', {
    cap: READ_BOARD,
    callers: 'all',
    scripts: true,
    handler: async (_params, ctx) => {
      const [scope, workspaces] = await Promise.all([scoped(ctx), listWorkspaces(deps)])
      return scope ? workspaces.filter((w) => scope.covers(w.workspaceId)) : workspaces
    },
  })
  registerControlMethod('workspace.groups', {
    cap: READ_BOARD,
    callers: 'all',
    scripts: true,
    handler: async (_params, ctx) => {
      const [scope, groups] = await Promise.all([scoped(ctx), listWorkspaceGroups(deps)])
      if (!scope) return groups
      return groups.flatMap((g) => {
        const workspaceIds = g.workspaceIds.filter(scope.covers)
        return scope.hasGroup(g.groupId) || workspaceIds.length > 0 ? [{ ...g, workspaceIds }] : []
      })
    },
  })
}
