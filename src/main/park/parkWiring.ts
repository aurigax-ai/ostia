import { stat } from 'node:fs/promises'
import { ipcMain } from 'electron'
import type { AgentResume } from '../../shared/agents/agentResume'
import { parseAgentResume } from '../../shared/agents/agentResume'
import type { CommandTarget } from '../../shared/control/commands'
import { PARKED_PANEL_EXTENSION_ID, type ParkOutcome } from '../../shared/park/park'
import type { AgentResumes } from '../agents/agentResumes'
import type { AgentRunningPanes } from '../agents/agentRunning'
import { backgroundWork, type ReportedAgentWork, readProcessTable } from '../agents/agentWork'
import { targetOf } from '../attention/attention'
import type { CommandBridge } from '../control/commandBridge'
import { type ExtensionMethodContext, registerControlMethod } from '../control/controlServer'
import { getByPaneId, panesOwnedBy, resolveExternal } from '../control/idRegistry'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { PaneJournal } from '../panes/paneJournal'
import { listPanes, listWorkspaces } from '../panes/paneList'
import { storePath } from '../platform/jsonStore'
import type { Redactor } from '../privacy/redaction'
import type { WorkspaceSandboxes } from '../sandbox/workspaceSandboxes'
import type { PtyEntry } from '../terminal/pty/ptyRegistry'
import type { ScratchFolders } from '../workspaces/scratchFolders'
import { parkPane } from './parkAct'
import { ParkedStore } from './parkedStore'
import { forgetParked, parkedItemOf, resumeParked } from './parkResume'

interface ParkWiringDeps {
  services: { extensionHost: ExtensionHost | null }
  execCommand: CommandBridge['execCommand']
  getTerminalState: Parameters<typeof listPanes>[0]['getTerminalState']
  ptyPid: (paneId: string) => number | undefined
  windowIds: () => string[]
  isWaking: (paneId: string) => boolean
  ptys: Map<string, PtyEntry>
  agentRunning: AgentRunningPanes
  agentWork: ReportedAgentWork
  agentResumes: AgentResumes
  paneJournal: PaneJournal
  redactor: Pick<Redactor, 'text'>
  scratchFolders: Pick<ScratchFolders, 'isScratch'>
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
  workspaceCommandTarget: (workspaceId: string) => CommandTarget
  remoteCwdOfPane: (paneId: string) => unknown
}

export function registerParkWiring(deps: ParkWiringDeps): ParkedStore {
  const store = new ParkedStore(storePath('parked-sessions', 'global'))
  const { execCommand, windowIds } = deps
  const panes = () =>
    listPanes({
      execCommand,
      getTerminalState: deps.getTerminalState,
      ptyPid: deps.ptyPid,
      windowIds,
      waking: deps.isWaking,
    })
  const workspaces = () => listWorkspaces({ execCommand, windowIds })

  const act = {
    store,
    identityOf: (paneId: string) => getByPaneId(paneId),
    workspaceKind: async (workspaceId: string) =>
      (await workspaces()).find((w) => w.workspaceId === workspaceId)?.kind ?? null,
    isScratch: (workspaceId: string) => deps.scratchFolders.isScratch(workspaceId),
    isSandboxed: (workspaceId: string) => deps.workspaceSandboxes.isEnabled(workspaceId),
    isRemote: (paneId: string) => Boolean(deps.remoteCwdOfPane(paneId)),
    agentRunning: (paneId: string) => deps.agentRunning.has(paneId),
    resumeOf: async (identity: NonNullable<ReturnType<typeof getByPaneId>>) => {
      const res = await execCommand(targetOf(identity), 'pane.resumeToken', undefined, true)
      return res.ok
        ? parseAgentResume((res.result as { resume?: unknown } | undefined)?.resume)
        : null
    },
    paneCwd: (paneId: string) => deps.getTerminalState(paneId)?.cwd,
    attentionState: async (identity: NonNullable<ReturnType<typeof getByPaneId>>) => {
      const res = await execCommand(targetOf(identity), 'attention.peek', undefined, true)
      return res.ok && res.result && typeof res.result === 'object'
        ? (res.result as { state?: string }).state
        : undefined
    },
    busy: async (paneId: string) => {
      const entry = deps.ptys.get(paneId)
      if (!entry) return 'unknown' as const
      return backgroundWork(deps.agentWork.reason(paneId), await readProcessTable(), entry.pty.pid)
    },
    closing: (paneId: string) => deps.paneJournal.closing(paneId),
    title: async (identity: NonNullable<ReturnType<typeof getByPaneId>>) =>
      (await panes()).find((p) => p.paneId === identity.paneId)?.title,
    redact: (text: string) => deps.redactor.text(text),
    lockedOf: async (identity: NonNullable<ReturnType<typeof getByPaneId>>) => {
      const res = await execCommand(targetOf(identity), 'pane.locked', undefined, true)
      return !res.ok || (res.result as { locked?: unknown } | undefined)?.locked !== false
    },
    closePane: async (identity: NonNullable<ReturnType<typeof getByPaneId>>) => {
      const res = await execCommand(
        targetOf(identity),
        'pane.close',
        { paneId: identity.paneId },
        true,
      )
      if (!res.ok) return res.error.message.startsWith('pane-locked') ? 'locked' : 'failed'
      return (await panes()).some((p) => p.paneId === identity.paneId) ? 'failed' : 'closed'
    },
  }

  ipcMain.handle(
    'park:pane',
    async (
      e,
      workspaceId: unknown,
      paneId: unknown,
      titlePinned: unknown,
    ): Promise<ParkOutcome> => {
      if (typeof workspaceId !== 'string' || typeof paneId !== 'string') {
        return { ok: false, reason: 'unavailable' }
      }
      const senderId = String(e.sender.id)
      if (!panesOwnedBy([paneId], senderId)) return { ok: false, reason: 'unavailable' }
      return parkPane(act, workspaceId, paneId, titlePinned === true)
    },
  )

  const fromActivity = (ctx: ExtensionMethodContext): boolean =>
    deps.services.extensionHost?.builtinId(ctx.identity, ctx.conn) === PARKED_PANEL_EXTENSION_ID
  const idOf = (params: unknown): string | null => {
    const id = (params as { id?: unknown } | null)?.id
    return typeof id === 'string' ? id : null
  }
  const NOT_ACTIVITY = { ok: false, error: 'activity-only' } as const

  registerControlMethod('ext.parkedList', {
    callers: 'extensions',
    cap: 'read-board',
    handler: (params, ctx: ExtensionMethodContext) => {
      if (!fromActivity(ctx)) return NOT_ACTIVITY
      const workspaceId = (params as { workspaceId?: unknown } | null)?.workspaceId
      if (typeof workspaceId !== 'string') return { ok: false, error: 'invalid-params' }
      return { ok: true, items: store.list(workspaceId).map(parkedItemOf) }
    },
  })

  registerControlMethod('ext.parkedResume', {
    callers: 'extensions',
    cap: 'read-board',
    handler: async (params, ctx: ExtensionMethodContext) => {
      if (!fromActivity(ctx)) return NOT_ACTIVITY
      const id = idOf(params)
      if (!id) return { ok: false, error: 'invalid-params' }
      return resumeParked(
        {
          store,
          workspaceOpen: async (workspaceId) =>
            (await workspaces()).some((w) => w.workspaceId === workspaceId),
          isDirectory: async (path) => (await stat(path).catch(() => null))?.isDirectory() === true,
          holderOf: async (resume: AgentResume) =>
            (await panes()).find(
              (p) =>
                p.agent === resume.agent && p.agentSessionId === resume.id && p.hibernated !== true,
            )?.title ?? null,
          openTab: async (workspaceId, record) => {
            const res = await execCommand(
              deps.workspaceCommandTarget(workspaceId),
              'agent.resumeParked',
              {
                workspaceId,
                resume: record.resume,
                ...(record.titlePinned ? { title: record.title } : {}),
              },
              true,
            )
            return res.ok && (res.result as { opened?: unknown } | undefined)?.opened === true
          },
        },
        id,
      )
    },
  })

  registerControlMethod('ext.parkedForget', {
    callers: 'extensions',
    cap: 'read-board',
    handler: (params, ctx: ExtensionMethodContext) => {
      if (!fromActivity(ctx)) return NOT_ACTIVITY
      const id = idOf(params)
      return id ? forgetParked(store, id) : { ok: false, error: 'invalid-params' }
    },
  })

  deps.agentResumes.subscribe((externalPaneId, resume) => {
    const pane = resolveExternal(externalPaneId)
    if (pane?.kind === 'pane') store.settle(pane.workspaceId, resume.agent, resume.id)
  })

  return store
}
