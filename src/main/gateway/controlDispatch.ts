import type { Capability } from '../../shared/capabilities'
import { plainBlock } from '../../shared/questions'
import type {
  CommandDescriptor,
  CommandResult,
  CommandTarget,
  TerminalStateSnapshot,
} from '../../shared/types'
import type { Ask, AskAnswerResult } from '../approvals/asks'
import { internalPaneArgs } from '../control/commandArgs'
import { resolveExternal } from '../control/idRegistry'
import type { PaneEntry, WorkspaceEntry, WorkspaceGroupEntry } from '../panes/paneList'
import { listArtifactFiles, locateArtifactFile, readArtifactFile } from './artifactFiles'
import {
  type PhoneFileScope,
  type WorkspaceFileOutcome,
  listWorkspaceFiles,
  readWorkspaceFile,
} from './workspaceFiles'

export interface GatewayControlDeps {
  execCommand: (target: CommandTarget, id: string, args?: unknown) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  listPanes: () => Promise<PaneEntry[]>
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  fileScope: (workspaceId: string) => PhoneFileScope
  artifactsDir: (workspaceId: string) => string | null
  openArtifact: (workspaceId: string, path: string) => Promise<boolean>
  listWorkspaceGroups: () => Promise<WorkspaceGroupEntry[]>
  primaryWindowId: () => string | undefined
  attachPhoneObserver: (
    rendererPaneId: string,
    opts: { sinceCursor?: number; role?: 'observer' | 'owner'; sendData: (data: string) => void },
  ) => { cursor: number; dropped: boolean; cols: number; rows: number; detach: () => void } | null
  ptyResize: (rendererPaneId: string, cols: number, rows: number) => void
  ptyWrite: (rendererPaneId: string, data: string) => void
  listAsks: () => Ask[]
  answerAsk: (askId: string, choiceId: unknown, text: unknown) => AskAnswerResult
  agentRunning: (rendererPaneId: string) => boolean
}

const PHONE_PROMPT_MAX = 8000
export const AGENT_ENTER_DELAY_MS = 60

const INTERRUPT_KEYS: Record<string, string> = { esc: '\x1b', 'ctrl-c': '\x03' }

function bracketedPaste(text: string): string {
  return `\x1b[200~${text}\x1b[201~`
}

export type RpcOutcome =
  | { ok: true; result: unknown }
  | { ok: false; code: number; message: string; data?: unknown }

function toWireSession(
  { workspaceId, groupId, ...rest }: WorkspaceEntry,
  groupNames: Map<string, string>,
): Record<string, unknown> {
  const name = groupId ? groupNames.get(groupId) : undefined
  return {
    sessionId: workspaceId,
    ...rest,
    ...(groupId && name !== undefined ? { group: { id: groupId, name } } : {}),
  }
}

function toWirePane({ workspaceId, ...rest }: PaneEntry): Record<string, unknown> {
  return { sessionId: workspaceId, ...rest }
}

function needsElevation(cap: string): RpcOutcome {
  return { ok: false, code: -32003, message: 'needs-elevation', data: { cap } }
}

function invalidParams(message: string): RpcOutcome {
  return { ok: false, code: -32602, message }
}

function fileOutcome<T>(outcome: WorkspaceFileOutcome<T>, wrap: (value: T) => unknown): RpcOutcome {
  return outcome.ok ? { ok: true, result: wrap(outcome.value) } : invalidParams(outcome.error)
}

type FileRoot = 'workspace' | 'artifacts'

function fileRootOf(root: unknown): FileRoot | null {
  if (root === undefined || root === 'workspace') return 'workspace'
  return root === 'artifacts' ? 'artifacts' : null
}

async function workspaceFolder(
  params: Record<string, unknown>,
  deps: GatewayControlDeps,
): Promise<{ workspaceId: string; workDir: string; path: string } | RpcOutcome> {
  const { sessionId, path } = params
  if (typeof sessionId !== 'string' || !sessionId) return invalidParams('missing sessionId')
  if (typeof path !== 'string') return invalidParams('missing path')
  const workspace = (await deps.listWorkspaces()).find((w) => w.workspaceId === sessionId)
  if (!workspace) return invalidParams('unknown-session')
  return { workspaceId: sessionId, workDir: workspace.workDir, path }
}

const PHONE_CAP_ALLOWS: Partial<Record<string, Capability[]>> = {
  read: ['read-board'],
  command: ['drive-self'],
  notify: ['notify'],
  destructive: ['destructive'],
}

function missingCapForPhone(desc: CommandDescriptor, deviceCaps: string[]): Capability | null {
  const allowed = new Set<Capability>()
  for (const phoneCap of deviceCaps) {
    for (const cap of PHONE_CAP_ALLOWS[phoneCap] ?? []) allowed.add(cap)
  }
  for (const cap of desc.capabilities) {
    if (!allowed.has(cap)) return cap
  }
  return null
}

function resolveTarget(target: unknown, primaryWindowId: string | undefined): CommandTarget | null {
  if (target === undefined || target === null) {
    return { windowId: primaryWindowId, workspaceId: '', paneId: null }
  }
  if (typeof target !== 'string' || !target) return null
  const identity = resolveExternal(target)
  if (!identity) return null
  return { windowId: identity.windowId, workspaceId: identity.workspaceId, paneId: identity.paneId }
}

function agentPaneOf(paneId: unknown, deps: GatewayControlDeps): string | RpcOutcome {
  if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
  const identity = resolveExternal(paneId)
  if (!identity || identity.kind !== 'pane' || identity.manager)
    return invalidParams('not-an-agent')
  if (!deps.agentRunning(identity.paneId)) {
    return invalidParams('not-an-agent')
  }
  return identity.paneId
}

export async function dispatchGatewayMethod(
  method: string,
  params: unknown,
  deviceCaps: string[],
  deps: GatewayControlDeps,
): Promise<RpcOutcome> {
  const p = (params ?? {}) as Record<string, unknown>
  const hasCap = (cap: string): boolean => deviceCaps.includes(cap)

  switch (method) {
    case 'session.list': {
      if (!hasCap('read')) return needsElevation('read')
      const [workspaces, groups] = await Promise.all([
        deps.listWorkspaces(),
        deps.listWorkspaceGroups(),
      ])
      const groupNames = new Map(groups.map((g) => [g.groupId, g.name]))
      return {
        ok: true,
        result: { sessions: workspaces.map((w) => toWireSession(w, groupNames)) },
      }
    }

    case 'pane.list': {
      if (!hasCap('read')) return needsElevation('read')
      return { ok: true, result: { panes: (await deps.listPanes()).map(toWirePane) } }
    }

    case 'command.list': {
      if (!hasCap('read')) return needsElevation('read')
      const windowId = deps.primaryWindowId()
      return { ok: true, result: { commands: windowId ? deps.listCommandsFor(windowId) : [] } }
    }

    case 'command.exec': {
      if (!hasCap('command')) return needsElevation('command')
      const id = p.id
      if (typeof id !== 'string' || !id) return invalidParams('missing command id')
      const windowId = deps.primaryWindowId()
      const descriptors = windowId ? deps.listCommandsFor(windowId) : []
      const desc = descriptors.find((d) => d.id === id)
      if (!desc) {
        return {
          ok: true,
          result: {
            ok: false,
            error: { code: 'unknown-command', message: `unknown command '${id}'` },
          },
        }
      }
      const missing = missingCapForPhone(desc, deviceCaps)
      if (missing) return needsElevation(missing)
      const target = resolveTarget(p.target, windowId)
      if (!target) return invalidParams('unknown pane target')
      const translated = internalPaneArgs(p.args)
      if (!translated.ok) return invalidParams(translated.error)
      return { ok: true, result: await deps.execCommand(target, id, translated.args) }
    }

    case 'pane.info': {
      if (!hasCap('read')) return needsElevation('read')
      const paneId = p.paneId
      if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
      const identity = resolveExternal(paneId)
      if (!identity) return invalidParams('unknown paneId')
      const state = deps.getTerminalState(identity.paneId)
      return {
        ok: true,
        result: {
          paneId,
          generation: state?.generation ?? 0,
          cwd: state?.cwd,
          running: state?.running ?? false,
          blockCount: state?.blockCount ?? 0,
          lastExitCode: state?.lastExitCode,
        },
      }
    }

    case 'cwd.get': {
      if (!hasCap('read')) return needsElevation('read')
      const paneId = p.paneId
      if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
      const identity = resolveExternal(paneId)
      const cwd = identity ? (deps.getTerminalState(identity.paneId)?.cwd ?? null) : null
      return { ok: true, result: { cwd } }
    }

    case 'fs.list': {
      if (!hasCap('read')) return needsElevation('read')
      const folder = await workspaceFolder(p, deps)
      if ('ok' in folder) return folder
      const root = fileRootOf(p.root)
      if (!root) return invalidParams('invalid-root')
      if (root === 'artifacts') {
        const dir = deps.artifactsDir(folder.workspaceId)
        if (!dir) return invalidParams('not-found')
        return fileOutcome(await listArtifactFiles(dir, folder.path), (entries) => ({ entries }))
      }
      const scope = deps.fileScope(folder.workspaceId)
      return fileOutcome(
        await listWorkspaceFiles(folder.workDir, folder.path, scope),
        (entries) => ({
          entries,
        }),
      )
    }

    case 'fs.read': {
      if (!hasCap('read')) return needsElevation('read')
      const folder = await workspaceFolder(p, deps)
      if ('ok' in folder) return folder
      const root = fileRootOf(p.root)
      if (!root) return invalidParams('invalid-root')
      if (root === 'artifacts') {
        const dir = deps.artifactsDir(folder.workspaceId)
        if (!dir) return invalidParams('not-found')
        return fileOutcome(
          await readArtifactFile(dir, folder.path, p.maxBytes, p.offset),
          (read) => read,
        )
      }
      const scope = deps.fileScope(folder.workspaceId)
      return fileOutcome(
        await readWorkspaceFile(folder.workDir, folder.path, p.maxBytes, scope, p.offset),
        (read) => read,
      )
    }

    case 'artifact.open': {
      if (!hasCap('command')) return needsElevation('command')
      const folder = await workspaceFolder(p, deps)
      if ('ok' in folder) return folder
      const dir = deps.artifactsDir(folder.workspaceId)
      if (!dir) return invalidParams('not-found')
      const located = await locateArtifactFile(dir, folder.path)
      if (!located.ok) return invalidParams(located.error)
      const opened = await deps.openArtifact(folder.workspaceId, located.value)
      return opened ? { ok: true, result: { ok: true } } : invalidParams('unknown-session')
    }

    case 'ask.list': {
      if (!hasCap('read')) return needsElevation('read')
      return { ok: true, result: { asks: deps.listAsks() } }
    }

    case 'ask.answer': {
      if (!hasCap('respond')) return needsElevation('respond')
      if (typeof p.askId !== 'string' || !p.askId) return invalidParams('missing askId')
      const answered = deps.answerAsk(p.askId, p.choiceId, p.text)
      return answered === 'ok' ? { ok: true, result: { ok: true } } : invalidParams(answered)
    }

    case 'agent.prompt': {
      if (!hasCap('respond')) return needsElevation('respond')
      const paneId = agentPaneOf(p.paneId, deps)
      if (typeof paneId !== 'string') return paneId
      if (typeof p.text !== 'string') return invalidParams('missing text')
      const text = plainBlock(p.text).slice(0, PHONE_PROMPT_MAX)
      if (!text) return invalidParams('missing text')
      deps.ptyWrite(paneId, bracketedPaste(text))
      setTimeout(() => {
        if (deps.agentRunning(paneId)) deps.ptyWrite(paneId, '\r')
      }, AGENT_ENTER_DELAY_MS)
      return { ok: true, result: { ok: true } }
    }

    case 'agent.interrupt': {
      if (!hasCap('respond')) return needsElevation('respond')
      const paneId = agentPaneOf(p.paneId, deps)
      if (typeof paneId !== 'string') return paneId
      const key =
        typeof p.key === 'string' && Object.hasOwn(INTERRUPT_KEYS, p.key)
          ? INTERRUPT_KEYS[p.key]
          : undefined
      if (!key) return invalidParams('unknown key')
      deps.ptyWrite(paneId, key)
      return { ok: true, result: { ok: true } }
    }

    default:
      return { ok: false, code: -32601, message: `method not found: ${method}` }
  }
}
