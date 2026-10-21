import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import { plainBlock } from '../../shared/agents/questions'
import type {
  CommandDescriptor,
  CommandResult,
  CommandSource,
  CommandTarget,
} from '../../shared/control/commands'
import type { HumanInputSource, TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import type { AgentStreams } from '../agents/agentStreams'
import type { Ask, AskAnswerResult } from '../approvals/asks'
import { internalPaneArgs } from '../control/commandArgs'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { PaneEntry, WorkspaceEntry, WorkspaceGroupEntry } from '../panes/paneList'
import type { PhoneAgent } from '../panes/phoneAgent'
import type { PhoneAgentStart } from '../panes/processManager'
import type { PhoneObserver } from '../terminal/pty/ptyIo'
import { listArtifactFiles, locateArtifactFile, readArtifactFile } from './artifactFiles'
import { agentStart } from './phone/phoneAgentStart'
import { imageAllowed, phoneImageOf } from './phone/phoneImage'
import { type PhoneSnippetDeps, snippetList } from './phone/phoneSnippets'
import { type PhoneTurnDeps, turnList, turnOutput, turnPane } from './phone/phoneTurns'
import {
  type PhonePushMethodDeps,
  pushRegister,
  pushTicket,
  pushUnregister,
} from './push/phonePushMethods'
import {
  listWorkspaceFiles,
  type PhoneFileScope,
  readWorkspaceFile,
  type WorkspaceFileOutcome,
} from './workspaceFiles'

export interface GatewayControlDeps extends PhoneTurnDeps, PhoneSnippetDeps, PhonePushMethodDeps {
  agentStreams: Pick<AgentStreams, 'open'>
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
    source?: CommandSource,
  ) => Promise<CommandResult>
  listCommandsFor: (windowId: string) => CommandDescriptor[]
  getTerminalState: (paneId: string) => TerminalStateSnapshot | undefined
  listPanes: () => Promise<PaneEntry[]>
  paneSince: (externalPaneId: string) => number | undefined
  waitingSince: (externalPaneId: string) => number | undefined
  sessionWaitingSince: (sessionId: string) => number | undefined
  listWorkspaces: () => Promise<WorkspaceEntry[]>
  fileScope: (workspaceId: string) => PhoneFileScope
  artifactsDir: (workspaceId: string) => string | null
  openArtifact: (workspaceId: string, path: string) => Promise<boolean>
  listWorkspaceGroups: () => Promise<WorkspaceGroupEntry[]>
  primaryWindowId: () => string | undefined
  attachPhoneObserver: (
    rendererPaneId: string,
    opts: {
      sinceCursor?: number
      role?: 'observer' | 'owner'
      sendData: (data: string) => void
      sendSize: (cols: number, rows: number) => void
    },
  ) => PhoneObserver | null
  ptyWrite: (rendererPaneId: string, data: string, source?: HumanInputSource) => void
  phoneInput: (rendererPaneId: string) => void
  readScreen: (rendererPaneId: string) => Promise<string>
  withClipboardImage: (bytes: Buffer, paste: () => Promise<boolean>) => Promise<boolean | null>
  listAsks: () => Ask[]
  answerAsk: (askId: string, choiceId: unknown, text: unknown) => AskAnswerResult
  agentRunning: (rendererPaneId: string) => boolean
  watchesTurn: (pane: PaneIdentity) => Promise<boolean>
  turnStarted: (pane: PaneIdentity) => Promise<boolean>
  phoneWorkspace: () => Promise<string | null>
  phoneDefaults: () => { set: boolean; agent: PhoneAgent }
  isPhoneWorkspace: (workDir: string) => boolean
  startAgent: (workspaceId: string, agent: PhoneAgent, prompt: string) => Promise<PhoneAgentStart>
}

const PHONE_PROMPT_MAX = 8000
export const AGENT_ENTER_DELAY_MS = 60
const IMAGE_PLACEHOLDER_POLL_MS = 50
export const IMAGE_PLACEHOLDER_WAIT_MS = 1500
const PASTE_IMAGE_KEY = '\x16'
const IMAGE_PLACEHOLDER = /\[Image #\d+\]/g

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

function toWirePane(
  { workspaceId, ...rest }: PaneEntry,
  since: number | undefined,
  waitingSince: number | undefined,
): Record<string, unknown> {
  return {
    sessionId: workspaceId,
    ...rest,
    ...(since === undefined ? {} : { since }),
    ...(rest.agentState === 'waiting' && waitingSince !== undefined ? { waitingSince } : {}),
  }
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

function agentPaneOf(paneId: unknown, deps: GatewayControlDeps): PaneIdentity | RpcOutcome {
  if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
  const identity = resolveExternal(paneId)
  if (identity?.kind !== 'pane' || identity.manager) return invalidParams('not-an-agent')
  if (!deps.agentRunning(identity.paneId)) {
    return invalidParams('not-an-agent')
  }
  return identity
}

function isOutcome(value: PaneIdentity | RpcOutcome): value is RpcOutcome {
  return 'ok' in value
}

function notSubmitted(pane: PaneIdentity): RpcOutcome {
  return { ok: false, code: -32005, message: 'not-submitted', data: { paneId: pane.externalId } }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface GatewayCall {
  p: Record<string, unknown>
  deviceCaps: string[]
  deviceId: string
  deps: GatewayControlDeps
}

async function sessionList(call: GatewayCall): Promise<RpcOutcome> {
  const { deps } = call
  const [workspaces, groups] = await Promise.all([
    deps.listWorkspaces(),
    deps.listWorkspaceGroups(),
  ])
  const groupNames = new Map(groups.map((g) => [g.groupId, g.name]))
  const sessions = workspaces.map((w) => ({
    ...toWireSession(w, groupNames),
    ...(deps.isPhoneWorkspace(w.workDir) ? { phone: true } : {}),
  }))
  return { ok: true, result: { sessions } }
}

async function paneList(call: GatewayCall): Promise<RpcOutcome> {
  const { deps } = call
  const panes = (await deps.listPanes()).map((pane) =>
    toWirePane(pane, deps.paneSince(pane.paneId), deps.waitingSince(pane.paneId)),
  )
  return { ok: true, result: { panes } }
}

async function commandList(call: GatewayCall): Promise<RpcOutcome> {
  const { deps } = call
  const windowId = deps.primaryWindowId()
  return { ok: true, result: { commands: windowId ? deps.listCommandsFor(windowId) : [] } }
}

async function commandExec(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps, deviceCaps } = call
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
  return { ok: true, result: await deps.execCommand(target, id, translated.args, false, 'phone') }
}

async function paneInfo(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
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

async function cwdGet(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
  const paneId = p.paneId
  if (typeof paneId !== 'string' || !paneId) return invalidParams('missing paneId')
  const identity = resolveExternal(paneId)
  const cwd = identity ? (deps.getTerminalState(identity.paneId)?.cwd ?? null) : null
  return { ok: true, result: { cwd } }
}

async function fsList(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
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
  return fileOutcome(await listWorkspaceFiles(folder.workDir, folder.path, scope), (entries) => ({
    entries,
  }))
}

async function fsRead(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
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

async function artifactOpen(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
  const folder = await workspaceFolder(p, deps)
  if ('ok' in folder) return folder
  const dir = deps.artifactsDir(folder.workspaceId)
  if (!dir) return invalidParams('not-found')
  const located = await locateArtifactFile(dir, folder.path)
  if (!located.ok) return invalidParams(located.error)
  const opened = await deps.openArtifact(folder.workspaceId, located.value)
  return opened ? { ok: true, result: { ok: true } } : invalidParams('unknown-session')
}

async function askList(call: GatewayCall): Promise<RpcOutcome> {
  const { deps } = call
  return { ok: true, result: { asks: deps.listAsks() } }
}

async function askAnswer(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
  if (typeof p.askId !== 'string' || !p.askId) return invalidParams('missing askId')
  const answered = deps.answerAsk(p.askId, p.choiceId, p.text)
  return answered === 'ok' ? { ok: true, result: { ok: true } } : invalidParams(answered)
}

function notPasted(pane: PaneIdentity): RpcOutcome {
  return { ok: false, code: -32005, message: 'not-pasted', data: { paneId: pane.externalId } }
}

async function placeholders(pane: PaneIdentity, deps: GatewayControlDeps): Promise<number> {
  return ((await deps.readScreen(pane.paneId)).match(IMAGE_PLACEHOLDER) ?? []).length
}

async function pasteImage(
  pane: PaneIdentity,
  bytes: Buffer,
  deps: GatewayControlDeps,
): Promise<boolean | null> {
  const before = await placeholders(pane, deps)
  return deps.withClipboardImage(bytes, async () => {
    deps.ptyWrite(pane.paneId, PASTE_IMAGE_KEY)
    for (let waited = 0; waited <= IMAGE_PLACEHOLDER_WAIT_MS; waited += IMAGE_PLACEHOLDER_POLL_MS) {
      if ((await placeholders(pane, deps)) > before) return true
      await wait(IMAGE_PLACEHOLDER_POLL_MS)
    }
    return false
  })
}

async function agentPrompt(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
  const pane = agentPaneOf(p.paneId, deps)
  if (isOutcome(pane)) return pane
  if (typeof p.text !== 'string') return invalidParams('missing text')
  const text = plainBlock(p.text).slice(0, PHONE_PROMPT_MAX)
  let bytes: Buffer | null = null
  if (p.image !== undefined) {
    const image = phoneImageOf(p.image)
    if (!Buffer.isBuffer(image)) return image
    const scope = await turnPane({ paneId: p.paneId }, deps)
    if ('ok' in scope) return scope
    if (!imageAllowed(call.deviceId)) return { ok: false, code: -32007, message: 'rate-limited' }
    bytes = image
  }
  if (!text && !bytes) return invalidParams('missing text')
  deps.phoneInput(pane.paneId)
  const watched = await deps.watchesTurn(pane)
  if (bytes) {
    const pasted = await pasteImage(pane, bytes, deps)
    if (pasted === null) return invalidParams('image-type')
    if (!pasted) return notPasted(pane)
    if (!text) return { ok: true, result: { ok: true, image: 'pasted' } }
  }
  deps.ptyWrite(pane.paneId, bracketedPaste(text), 'paste')
  await wait(AGENT_ENTER_DELAY_MS)
  if (!deps.agentRunning(pane.paneId)) return notSubmitted(pane)
  deps.ptyWrite(pane.paneId, '\r', 'key')
  if (watched && !(await deps.turnStarted(pane))) return notSubmitted(pane)
  return { ok: true, result: { ok: true, ...(bytes ? { image: 'pasted' } : {}) } }
}

async function agentInterrupt(call: GatewayCall): Promise<RpcOutcome> {
  const { p, deps } = call
  const pane = agentPaneOf(p.paneId, deps)
  if (isOutcome(pane)) return pane
  const key =
    typeof p.key === 'string' && Object.hasOwn(INTERRUPT_KEYS, p.key)
      ? INTERRUPT_KEYS[p.key]
      : undefined
  if (!key) return invalidParams('unknown key')
  deps.phoneInput(pane.paneId)
  deps.ptyWrite(pane.paneId, key)
  return { ok: true, result: { ok: true } }
}

const METHODS: Record<string, [cap: string, handler: (call: GatewayCall) => Promise<RpcOutcome>]> =
  {
    'session.list': ['read', sessionList],
    'pane.list': ['read', paneList],
    'command.list': ['read', commandList],
    'command.exec': ['command', commandExec],
    'pane.info': ['read', paneInfo],
    'cwd.get': ['read', cwdGet],
    'fs.list': ['read', fsList],
    'fs.read': ['read', fsRead],
    'artifact.open': ['command', artifactOpen],
    'ask.list': ['read', askList],
    'ask.answer': ['respond', askAnswer],
    'agent.prompt': ['respond', agentPrompt],
    'agent.start': ['respond', (call) => agentStart(call.p, call.deviceId, call.deps)],
    'agent.interrupt': ['respond', agentInterrupt],
    'turn.list': ['read', (call) => turnList(call.p, call.deps)],
    'turn.output': ['read', (call) => turnOutput(call.p, call.deps)],
    'snippet.list': ['read', (call) => snippetList(call.p, call.deps)],
    'push.ticket': ['notify', (call) => pushTicket(call.deviceId, call.deps)],
    'push.register': ['notify', async (call) => pushRegister(call.deviceId, call.p, call.deps)],
    'push.unregister': ['notify', async (call) => pushUnregister(call.deviceId, call.deps)],
  }

export async function dispatchGatewayMethod(
  method: string,
  params: unknown,
  deviceCaps: string[],
  deps: GatewayControlDeps,
  deviceId = '',
): Promise<RpcOutcome> {
  const entry = Object.hasOwn(METHODS, method) ? METHODS[method] : undefined
  if (!entry) return { ok: false, code: -32601, message: `method not found: ${method}` }
  const [cap, handler] = entry
  if (!deviceCaps.includes(cap)) return needsElevation(cap)
  return handler({ p: (params ?? {}) as Record<string, unknown>, deviceCaps, deviceId, deps })
}
