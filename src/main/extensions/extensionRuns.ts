import { homedir } from 'node:os'
import { isAbsolute } from 'node:path'
import {
  AGENT_PLUGIN_CAPABILITY,
  type AgentHookEvent,
} from '@aurigax-ai/ostia-extension-sdk/contract/agentPlugins'
import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import {
  AGENT_OFFER_LABEL_MAX,
  AGENT_OFFER_TEXT_MAX,
  AGENT_PROMPT_MAX,
  type ExtensionEventPayloads,
  type ExtensionEventType,
  OPEN_TERMINAL_WAIT_MAX_MS,
  TERMINAL_ARG_MAX,
  TERMINAL_COMMAND_MAX_ARGS,
  TERMINAL_TITLE_MAX,
  type TerminalWait,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc/node'
import { quoteArgv } from '../../shared/terminal/shellQuote'
import {
  agentName,
  agentPrompt,
  agentTaskLimiter,
  continueCommand,
  offerLabel,
  offerText,
  REACHED_PANES_MAX,
  workspaceFolder,
  workspaceIdOf,
} from '../agents/extensionAgents'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import { spawnFolder } from '../terminal/spawnCwd'
import type { ExtensionHostDeps } from './extensionHostDeps'
import { fail, type Runtime } from './extensionRuntime'

function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

const HOST_TERMINAL_NOTE = 'Runs outside the sandbox, in a terminal you can watch:'

export interface TerminalOpenRequest {
  command: string
  hostToken?: string
  workspaceId?: string
  windowId?: string
  afterPaneId?: string
  cwd?: string
  title?: string
  backgroundTab?: boolean
  pinTitle?: boolean
}

export interface ExtensionConfirmRequest {
  extId: string
  extName: string
  title: string
  message: string
  detail?: string
  confirmLabel?: string
  cancelLabel?: string
}

const CONFIRM_TITLE_MAX = 120

const CONFIRM_MESSAGE_MAX = 500

const CONFIRM_DETAIL_MAX = 2000

const CONFIRM_LABEL_MAX = 40

function terminalWaitMs(raw: unknown): number | null | string {
  if (raw === undefined) return null
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return 'waitMs must be a positive number of milliseconds'
  }
  return Math.min(Math.round(raw), OPEN_TERMINAL_WAIT_MAX_MS)
}

function terminalArgv(raw: unknown): string[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return 'command must be a non-empty array'
  if (raw.length > TERMINAL_COMMAND_MAX_ARGS) {
    return `command is limited to ${TERMINAL_COMMAND_MAX_ARGS} arguments`
  }
  for (const arg of raw) {
    if (typeof arg !== 'string') return 'command arguments must be strings'
    if (arg.length > TERMINAL_ARG_MAX)
      return `arguments are limited to ${TERMINAL_ARG_MAX} characters`
    if (hasControlChar(arg)) return 'command arguments must not contain control characters'
  }
  if (!raw[0]) return 'command must start with a program'
  return raw as string[]
}

export interface ExtensionRunsHost {
  deps: Pick<
    ExtensionHostDeps,
    | 'agentArgv'
    | 'adoptPane'
    | 'agentTaskClock'
    | 'agentNames'
    | 'confirm'
    | 'exec'
    | 'focusPaneIn'
    | 'hostGrants'
    | 'isSandboxed'
    | 'offerToAgentIn'
    | 'openTerminalIn'
    | 'resumeOf'
    | 'workDirForWorkspace'
  >
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  shownName(rt: Runtime): string
  runtimes: ReadonlyMap<string, Runtime>
  active(rt: Runtime): boolean
  granted(rt: Runtime): Capability[]
}

export class ExtensionRuns {
  constructor(private readonly host: ExtensionRunsHost) {
    this.agentTasks = agentTaskLimiter(host.deps.agentTaskClock)
  }

  private terminalWaits = new Map<string, (wait: TerminalWait) => void>()

  private readonly agentTasks: ReturnType<typeof agentTaskLimiter>

  async openTerminal(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const p = (params ?? {}) as Record<string, unknown>
    const argv = terminalArgv(p.command)
    if (typeof argv === 'string') return fail('invalid-params', argv)
    const rt = this.host.runtimeOf(identity, conn)
    const command = quoteArgv(argv)
    const req: TerminalOpenRequest = { command }
    const workspaceId =
      typeof p.workspaceId === 'string' && p.workspaceId ? p.workspaceId : undefined
    let after: PaneIdentity | undefined
    if (p.afterPaneId !== undefined) {
      after = typeof p.afterPaneId === 'string' ? resolveExternal(p.afterPaneId) : undefined
      if (after?.kind !== 'pane') return fail('unknown-pane', 'afterPaneId is not a pane')
      if (workspaceId && workspaceId !== after.workspaceId) {
        return fail('invalid-params', 'afterPaneId is not in that workspace')
      }
      req.afterPaneId = after.paneId
      req.workspaceId = after.workspaceId
      req.windowId = after.windowId
    } else if (workspaceId) {
      req.workspaceId = workspaceId
    }
    if (p.host === true && this.host.deps.isSandboxed(req.workspaceId ?? '')) {
      const token = this.host.deps.hostGrants?.claim(rt.ext.manifest.id, command) ?? null
      if (!token)
        return fail(
          'host-not-approved',
          'a host terminal needs an approved ext.confirm with hostTerminal',
        )
      req.hostToken = token
      req.command = `${command}; exit`
    }
    if (p.cwd !== undefined) {
      if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) {
        return fail('invalid-params', 'cwd must be absolute')
      }
      req.cwd = p.cwd
    }
    if (typeof p.title === 'string' && p.title.trim()) {
      req.title = p.title.trim().slice(0, TERMINAL_TITLE_MAX)
    }
    const waitMs = terminalWaitMs(p.waitMs)
    if (typeof waitMs === 'string') return fail('invalid-params', waitMs)
    if (!this.host.deps.openTerminalIn) return fail('no-window')
    const paneId = await this.host.deps.openTerminalIn(req)
    if (!paneId) return fail('not-opened', 'no workspace to open it in')
    this.reach(rt, paneId)
    this.markOpened(rt, paneId)
    this.adoptForCaller(rt, after, paneId, p.host === true)
    if (waitMs === null) return { ok: true, paneId }
    return { ok: true, paneId, wait: await this.waitForTerminal(paneId, waitMs) }
  }

  private adoptForCaller(
    rt: Runtime,
    after: PaneIdentity | undefined,
    paneId: string,
    host: boolean,
  ): void {
    if (host || after?.kind !== 'pane' || after.manager === true) return
    const calls = rt.serving.get(after.externalId)
    if (!calls || calls.cli === 0 || calls.user > 0) return
    const opened = resolveExternal(paneId)
    if (opened?.kind === 'pane') this.host.deps.adoptPane?.(after.paneId, opened.paneId)
  }

  private waitForTerminal(paneId: string, ms: number): Promise<TerminalWait> {
    this.terminalWaits.get(paneId)?.({ outcome: 'timeout' })
    return new Promise((resolve) => {
      const settle = (wait: TerminalWait): void => {
        clearTimeout(timer)
        if (this.terminalWaits.get(paneId) === settle) this.terminalWaits.delete(paneId)
        resolve(wait)
      }
      const timer = setTimeout(() => settle({ outcome: 'timeout' }), ms)
      timer.unref?.()
      this.terminalWaits.set(paneId, settle)
    })
  }

  settleTerminalWait<T extends ExtensionEventType>(
    type: T,
    payload: ExtensionEventPayloads[T],
  ): void {
    if (type !== 'command.finished' && type !== 'pane.closed') return
    const { paneId, exitCode } = payload as { paneId: string; exitCode?: number }
    const settle = this.terminalWaits.get(paneId)
    if (!settle) return
    settle(type === 'pane.closed' ? { outcome: 'closed' } : { outcome: 'finished', exitCode })
  }

  private reach(rt: Runtime, paneId: string): void {
    if (rt.reached.size >= REACHED_PANES_MAX) {
      for (const id of rt.reached) if (resolveExternal(id)?.kind !== 'pane') rt.reached.delete(id)
    }
    if (rt.reached.size < REACHED_PANES_MAX) rt.reached.add(paneId)
  }

  private takeAgentTask(rt: Runtime): boolean {
    return this.agentTasks.take(rt.ext.manifest.id).allowed
  }

  agentNames(identity: PaneIdentity, conn: MessageConnection) {
    this.host.runtimeOf(identity, conn)
    return { ok: true, agents: this.host.deps.agentNames?.() ?? [] }
  }

  async runAgent(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = isRecord(params) ? params : {}
    const workspaceId = workspaceIdOf(p.workspaceId)
    if (!workspaceId) return fail('invalid-params', 'workspaceId is required')
    if (p.background !== undefined && typeof p.background !== 'boolean') {
      return fail('invalid-params', 'background is true or false')
    }
    const prompt = agentPrompt(p.prompt)
    if (!prompt) {
      return fail(
        'invalid-params',
        `prompt must be 1-${AGENT_PROMPT_MAX} characters without control characters other than newlines and tabs`,
      )
    }
    const planned =
      p.continueFrom === undefined
        ? this.startCommand(p.agent, prompt, workspaceId)
        : await this.continuedCommand(rt, p.continueFrom, prompt, workspaceId)
    if ('error' in planned) return planned.error
    if (!this.host.deps.openTerminalIn) return fail('no-window')
    if (!this.takeAgentTask(rt)) return fail('rate-limited', 'too many agent tasks this minute')
    const paneId = await this.host.deps.openTerminalIn({
      command: planned.command,
      workspaceId,
      ...(planned.cwd ? { cwd: planned.cwd } : {}),
      ...(p.background === true ? { backgroundTab: true } : {}),
    })
    if (!paneId) return fail('not-opened', 'no workspace to open it in')
    this.reach(rt, paneId)
    this.markOpened(rt, paneId)
    return { ok: true, paneId }
  }

  private markOpened(rt: Runtime, paneId: string): void {
    if (rt.opened.size >= REACHED_PANES_MAX) {
      for (const id of rt.opened) if (resolveExternal(id)?.kind !== 'pane') rt.opened.delete(id)
    }
    if (rt.opened.size < REACHED_PANES_MAX) rt.opened.add(paneId)
  }

  private startCommand(
    raw: unknown,
    prompt: string,
    workspaceId: string,
  ): { command: string; cwd?: string } | { error: unknown } {
    const agent = agentName(raw)
    if (!agent) {
      return { error: fail('invalid-params', 'agent must be one of the names ext.agents lists') }
    }
    const argv = this.host.deps.agentArgv?.(agent)
    if (!argv) return { error: fail('unknown-agent', 'no agent by that name') }
    const cwd = workspaceFolder(this.host.deps.workDirForWorkspace(workspaceId), homedir())
    return { command: quoteArgv([...argv, prompt]), ...(cwd ? { cwd } : {}) }
  }

  private async continuedCommand(
    rt: Runtime,
    raw: unknown,
    prompt: string,
    workspaceId: string,
  ): Promise<{ command: string; cwd: string } | { error: unknown }> {
    if (typeof raw !== 'string' || !rt.opened.has(raw)) {
      return {
        error: fail(
          'not-reached',
          'continueFrom is only for a pane you opened with ext.runAgent or ext.openTerminal',
        ),
      }
    }
    const pane = resolveExternal(raw)
    if (pane?.kind !== 'pane' || pane.workspaceId !== workspaceId) {
      return { error: fail('unknown-pane', 'that pane is closed or in another workspace') }
    }
    const found = await this.host.deps.resumeOf?.(pane)
    if (!found) return { error: fail('no-session', 'that pane has no agent session to continue') }
    const folder = spawnFolder(found.resume.cwd)
    if (folder.missing) {
      return { error: fail('resume-folder-missing', `${found.resume.cwd} no longer exists`) }
    }
    return { command: continueCommand(found, prompt), cwd: folder.cwd }
  }

  async offerToAgent(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = isRecord(params) ? params : {}
    const workspaceId = workspaceIdOf(p.workspaceId)
    if (!workspaceId) return fail('invalid-params', 'workspaceId is required')
    const text = offerText(p.text)
    if (!text) {
      return fail(
        'invalid-params',
        `text must be one line of 1-${AGENT_OFFER_TEXT_MAX} characters without control characters`,
      )
    }
    const label = offerLabel(p.label)
    if (!label) {
      return fail(
        'invalid-params',
        `label must be one line of 1-${AGENT_OFFER_LABEL_MAX} characters without control characters`,
      )
    }
    if (!this.host.deps.offerToAgentIn) return fail('no-window')
    if (rt.offering) return fail('busy', 'an earlier offer is still waiting for the human')
    if (!this.takeAgentTask(rt)) return fail('rate-limited', 'too many agent tasks this minute')
    rt.offering = true
    try {
      const delivery = await this.host.deps.offerToAgentIn({
        extId: rt.ext.manifest.id,
        extName: this.host.shownName(rt),
        workspaceId,
        label,
        text,
      })
      if (!delivery.delivered) return fail('unknown-workspace', 'no window holds that workspace')
      if (!delivery.paneId) return { ok: true, sent: false }
      this.reach(rt, delivery.paneId)
      return { ok: true, sent: true, paneId: delivery.paneId }
    } finally {
      rt.offering = false
    }
  }

  focusPane(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const paneId = isRecord(params) ? params.paneId : undefined
    if (typeof paneId !== 'string' || !rt.reached.has(paneId)) {
      return fail(
        'not-reached',
        'only a pane you opened, the human picked for you, or whose agent hook reached you',
      )
    }
    const pane = resolveExternal(paneId)
    if (pane?.kind !== 'pane') {
      rt.reached.delete(paneId)
      return fail('unknown-pane', 'that pane is closed')
    }
    if (!this.host.deps.focusPaneIn) return fail('no-window')
    return this.host.deps.focusPaneIn(pane)
      ? { ok: true }
      : fail('unknown-pane', 'that pane is closed')
  }

  declaresHook(extId: string, command: string, event?: AgentHookEvent): boolean {
    const rt = this.host.runtimes.get(extId)
    if (!rt || !this.host.active(rt) || !this.host.granted(rt).includes(AGENT_PLUGIN_CAPABILITY)) {
      return false
    }
    const hooks = rt.ext.manifest.contributes.agentHooks ?? []
    return hooks.some((hook) => hook.command === command && (!event || hook.event === event))
  }

  reachHookCaller(extId: string, command: string, identity: PaneIdentity): void {
    if (identity.kind !== 'pane' || !this.declaresHook(extId, command)) return
    const rt = this.host.runtimes.get(extId)
    if (rt) this.reach(rt, identity.externalId)
  }

  exec(
    identity: PaneIdentity,
    conn: MessageConnection,
    params: unknown,
    token?: CancellationToken,
  ) {
    const rt = this.host.runtimeOf(identity, conn)
    if (!this.host.deps.exec) return fail('no-window')
    const abort = new AbortController()
    token?.onCancellationRequested(() => abort.abort())
    if (token?.isCancellationRequested) abort.abort()
    return this.host.deps.exec.run(rt.ext.manifest.id, params, abort.signal)
  }

  async confirm(identity: PaneIdentity, conn: MessageConnection, params: unknown) {
    const rt = this.host.runtimeOf(identity, conn)
    const p = (params ?? {}) as Record<string, unknown>
    const text = (v: unknown, max: number): string =>
      typeof v === 'string' ? v.trim().slice(0, max) : ''
    const title = text(p.title, CONFIRM_TITLE_MAX)
    const message = text(p.message, CONFIRM_MESSAGE_MAX)
    if (!title || !message) return fail('invalid-params', 'title and message are required')
    if (!this.host.deps.confirm) return fail('no-window')
    const req: ExtensionConfirmRequest = {
      extId: rt.ext.manifest.id,
      extName: this.host.shownName(rt),
      title,
      message,
    }
    const detail = text(p.detail, CONFIRM_DETAIL_MAX)
    if (detail) req.detail = detail
    const confirmLabel = text(p.confirmLabel, CONFIRM_LABEL_MAX)
    if (confirmLabel) req.confirmLabel = confirmLabel
    const cancelLabel = text(p.cancelLabel, CONFIRM_LABEL_MAX)
    if (cancelLabel) req.cancelLabel = cancelLabel
    let hostCommand: string | null = null
    if (p.hostTerminal !== undefined) {
      const argv = terminalArgv(p.hostTerminal)
      if (typeof argv === 'string') return fail('invalid-params', argv)
      hostCommand = quoteArgv(argv)
      req.detail = `${req.detail ? `${req.detail}\n\n` : ''}${HOST_TERMINAL_NOTE}\n${hostCommand}`
    }
    const confirmed = await this.host.deps.confirm(req)
    if (confirmed && hostCommand) this.host.deps.hostGrants?.offer(rt.ext.manifest.id, hostCommand)
    return { ok: true, confirmed }
  }
}
