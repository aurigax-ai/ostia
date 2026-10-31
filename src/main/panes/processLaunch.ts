import { isAbsolute } from 'node:path'
import { PRODUCT_DISPLAY_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/productDisplay'
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import { leadsWithFlag, resumeFlags } from '../../shared/agents/agentLaunch'
import { isResumableAgent } from '../../shared/agents/agentResume'
import { MANAGER_AGENT_NAME } from '../../shared/agents/managerSettings'
import { anyOf, type ChangeSignal, type Subscribe } from '../../shared/common/actThenConfirm'
import type { RemoteStartAnswer } from '../../shared/remote/remoteHandoff'
import {
  normalizeSplitTabName,
  SPLIT_TAB_NAME_MAX,
  type SplitTabPlacement,
} from '../../shared/workspaces/splitTabs'
import type { Reach } from '../approvals/reach'
import type { ControlMethodContext } from '../control/controlServer'
import { resolveExternal } from '../control/idRegistry'
import type { TerminalOpenRequest } from '../extensions/extensionRuns'
import { repoSnapshot } from '../git/repoSnapshot'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import type { ProcessEntry, ProcessRegistry } from './processRegistry'
import type { RemoteStarter } from './remoteStart'
import {
  confirmStart,
  confirmTurn,
  START_TIMING,
  type StartReport,
  type StartTiming,
  startMessage,
} from './startConfirm'

const PROCESS_COMMAND_MAX = 8 * 1024
const PROCESS_NAME_MAX = 60

export interface ProcessTabRequest extends TerminalOpenRequest {
  openedPaneIds?: string[]
  splitTab?: SplitTabPlacement
}

interface StartedRemote {
  id: string
  name: string
  paneId: string
  status: 'started'
  ref: string
  session?: string
}

type RemoteRefusal = { ok: false; error: string; message: string }

type StartedProcess = { id: string; name: string; paneId: string } & StartReport

const NOT_OPENED = {
  ok: false as const,
  error: 'not-opened' as const,
  message: `${PRODUCT_DISPLAY_NAME} could not open a terminal tab`,
}
function humanTab(name: string) {
  return {
    ok: false as const,
    error: 'human-tab' as const,
    message: `split tab ${name} is the human's; agents join only split tabs an agent made`,
  }
}

function hasControlCharacters(text: string, allowed: string): boolean {
  for (const ch of text) {
    if ((ch < ' ' || ch === '\x7f') && !allowed.includes(ch)) return true
  }
  return false
}

export function badRequest(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidParams, `bad-request: ${message}`)
}

export function commandOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw badRequest('cmd')
  if (raw.length > PROCESS_COMMAND_MAX) throw badRequest('cmd is too long')
  if (hasControlCharacters(raw, '\n\t')) throw badRequest('cmd has control characters')
  return raw
}

export function agentOf(raw: unknown): string {
  if (typeof raw !== 'string' || !MANAGER_AGENT_NAME.test(raw)) throw badRequest('agent')
  return raw
}

export function modelFlags(argv: readonly string[], raw: unknown): string[] {
  if (raw === undefined || raw === null) return []
  const program = argv[0]?.split('/').pop()
  if (typeof raw !== 'string' || !isResumableAgent(program)) throw badRequest('model')
  const flags = ['--model', raw]
  const kept = resumeFlags(program, flags)
  if (kept.length !== flags.length || kept.some((word, i) => word !== flags[i])) {
    throw badRequest('model')
  }
  return flags
}

export function promptOf(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim() || leadsWithFlag(raw)) throw badRequest('prompt')
  return raw.trim()
}

export function nameOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') throw badRequest('name')
  const name = raw.trim()
  if (!name) return undefined
  if (name.length > PROCESS_NAME_MAX) throw badRequest('name is too long')
  if (hasControlCharacters(name, '')) throw badRequest('name has control characters')
  return name
}

export function defaultName(cmd: string): string {
  return (cmd.trim().split(/\s+/)[0] ?? '').slice(0, PROCESS_NAME_MAX)
}

export function splitTabOf(rawName: unknown): SplitTabPlacement | undefined {
  if (rawName === undefined || rawName === null) return undefined
  const name = normalizeSplitTabName(rawName)
  if (!name) throw badRequest('tab')
  return { name }
}

const WORKERS_SUFFIX = ' · workers'

function workersTabName(title: string): string | undefined {
  return (
    normalizeSplitTabName(
      `${title.trim().slice(0, SPLIT_TAB_NAME_MAX - WORKERS_SUFFIX.length)}${WORKERS_SUFFIX}`,
    ) ?? undefined
  )
}

export function cwdOf(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !isAbsolute(raw)) throw badRequest('cwd must be absolute')
  return raw
}

export const workspaceOf = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string' || !raw) throw badRequest('workspace')
  return raw
}

export interface ProcessLaunchDeps {
  openTab: (req: ProcessTabRequest) => Promise<string | null>
  cwdOfPane: (paneId: string) => string | undefined
  isAgent: (paneId: string) => boolean
  paneTitle: (paneId: string) => Promise<string | undefined>
  splitTabNow: (
    workspaceId: string,
    paneId: string,
  ) => Promise<{ name: string | null; human: boolean } | null>
  humanTab: (workspaceId: string, name: string) => Promise<boolean>
  agentStarted: (paneId: string) => boolean
  turnState: (paneId: string) => Promise<string | undefined>
  agentSession: (paneId: string) => Promise<string | undefined>
  agentChanges: Subscribe
  tell: (toExternalId: string, text: string) => void
  startTiming?: StartTiming
  isSandboxed: (workspaceId: string) => boolean
  remote?: RemoteStarter
  reach: Pick<Reach, 'ensure'>
  onChange?: (entry: ProcessEntry) => void
}

export function createProcessLauncher(
  deps: ProcessLaunchDeps & { registry: ProcessRegistry; registryChanges: ChangeSignal },
) {
  const { registry, registryChanges } = deps

  const currentWorkersTab = async (caller: string, remembered: string) => {
    for (const entry of registry.list(null)) {
      if (entry.ownerPaneId !== caller || entry.status === 'closed') continue
      if (entry.splitTab !== remembered) continue
      const now = await deps.splitTabNow(registry.workspaceOf(entry), entry.paneId)
      if (now?.name) return now
    }
    return null
  }

  const workersTab = async (
    ctx: ControlMethodContext,
    workspaceId: string,
  ): Promise<SplitTabPlacement | undefined> => {
    const caller = ctx.identity.paneId
    if (ctx.identity.kind !== 'pane' || !caller || !deps.isAgent(caller)) return undefined
    const remembered = registry.workersTabOf(caller)
    if (remembered) {
      const now = await currentWorkersTab(caller, remembered)
      if (now?.name) return now.human ? undefined : { name: now.name }
    }
    const title = remembered ? undefined : await deps.paneTitle(caller)
    const name = remembered ?? (title ? workersTabName(title) : undefined)
    if (!name) return undefined
    registry.rememberWorkersTab(caller, name)
    return (await deps.humanTab(workspaceId, name)) ? undefined : { name }
  }

  const openAndConfirm = async (
    req: Omit<ProcessTabRequest, 'backgroundTab' | 'pinTitle'> & {
      title: string
      workspaceId: string
    },
    ownerPaneId: string,
    agentHook: boolean,
    awaitTurn = false,
  ): Promise<{ entry: ProcessEntry; report: StartReport } | null> => {
    const opened = await deps.openTab({ ...req, backgroundTab: true, pinTitle: true })
    const pane = opened ? resolveExternal(opened) : undefined
    if (pane?.kind !== 'pane') return null
    const entry = registry.add({
      name: req.title,
      cmd: req.command,
      cwd: req.cwd,
      workspaceId: req.workspaceId,
      ownerPaneId,
      paneId: pane.paneId,
      externalPaneId: pane.externalId,
      ...(req.splitTab ? { splitTab: req.splitTab.name } : {}),
    })
    const changes = anyOf(registryChanges.subscribe, deps.agentChanges)
    const timing = deps.startTiming ?? START_TIMING
    const started = await confirmStart({
      registry,
      entry,
      agentHook,
      agentStarted: deps.agentStarted,
      changes,
      timing,
    })
    const report =
      awaitTurn && started.status === 'started'
        ? {
            ...started,
            ...(await confirmTurn({
              entry,
              turnState: deps.turnState,
              session: deps.agentSession,
              changes,
              timing,
            })),
          }
        : started
    entry.start = report.status
    deps.onChange?.(entry)
    return { entry, report }
  }

  const admit = async (
    ctx: ControlMethodContext,
    givenWorkspace: string | undefined,
  ): Promise<{ workspaceId: string; here: boolean }> => {
    const home = ctx.identity.workspaceId
    const workspaceId = givenWorkspace ?? home
    if (!workspaceId) {
      throw badRequest(
        'workspace: a script token has no workspace of its own; pass --workspace <id|name> (ostia workspace list), which needs all-workspaces on the token',
      )
    }
    const here = workspaceId === home
    if (!here && home && deps.isSandboxed(home)) {
      throw new ResponseError(ErrorCodes.InvalidRequest, SANDBOXED_REFUSAL)
    }
    if (!here) {
      await deps.reach.ensure(
        ctx,
        workspaceId,
        'process.run',
        `open a terminal in workspace ${workspaceId}`,
      )
    }
    return { workspaceId, here }
  }

  const runRemote = async (
    ctx: ControlMethodContext,
    givenWorkspace: string | undefined,
    input: { agent: string; prompt: string; model?: string; title: string },
  ): Promise<StartedRemote | RemoteRefusal | null> => {
    const remote = deps.remote
    const target = givenWorkspace ?? ctx.identity.workspaceId
    if (!remote || !target || !(await remote.isRemote(target))) return null
    const { workspaceId } = await admit(ctx, givenWorkspace)
    const cwd = deps.cwdOfPane(ctx.identity.paneId)
    if (!cwd) {
      return { ok: false, error: 'no-folder', message: 'the calling pane has no folder to send' }
    }
    const snapshot = await repoSnapshot(cwd)
    if (!snapshot.ok) return snapshot
    const answer: RemoteStartAnswer = await remote.start({
      agent: input.agent as 'claude' | 'codex',
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
      title: input.title,
      workspaceId,
      root: snapshot.root,
      repo: snapshot.repo,
    })
    if (!answer.ok) return answer
    return {
      id: answer.jobId,
      name: input.title,
      paneId: answer.paneId,
      status: 'started',
      ref: answer.ref,
      ...(answer.session ? { session: answer.session } : {}),
    }
  }

  const runInTab = async (
    ctx: ControlMethodContext,
    cmd: string,
    name: string,
    givenCwd: string | undefined,
    givenWorkspace: string | undefined,
    splitTab: SplitTabPlacement | undefined,
    agentHook: boolean,
    named: boolean,
  ): Promise<StartedProcess | typeof NOT_OPENED | ReturnType<typeof humanTab>> => {
    const { workspaceId, here } = await admit(ctx, givenWorkspace)
    if (named && splitTab && (await deps.humanTab(workspaceId, splitTab.name))) {
      return humanTab(splitTab.name)
    }
    const cwd = givenCwd ?? (here ? deps.cwdOfPane(ctx.identity.paneId) : undefined)
    const started = await openAndConfirm(
      {
        command: cmd,
        workspaceId,
        ...(here
          ? {
              windowId: ctx.identity.windowId,
              afterPaneId: ctx.identity.paneId,
              openedPaneIds: registry.openedBy(ctx.identity.paneId),
            }
          : {}),
        title: name,
        ...(cwd ? { cwd } : {}),
        ...(splitTab ? { splitTab } : {}),
      },
      ctx.identity.paneId,
      agentHook,
      agentHook,
    )
    if (!started) return NOT_OPENED
    const { entry, report } = started
    const caller = ctx.identity
    if (caller.kind === 'pane' && caller.paneId && deps.isAgent(caller.paneId)) {
      deps.tell(caller.externalId, startMessage(entry.name, entry.externalPaneId, report))
    }
    return { id: entry.id, name: entry.name, paneId: entry.externalPaneId, ...report }
  }

  return { runInTab, runRemote, workersTab, openAndConfirm }
}
