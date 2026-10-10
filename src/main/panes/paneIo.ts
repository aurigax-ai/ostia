import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../../shared/capabilities'
import type { CommandResult, TerminalStateSnapshot } from '../../shared/types'
import { ensureCaps } from '../approvals/controlElevation'
import type { Reach } from '../approvals/reach'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, getByPaneId, resolveExternal } from '../control/idRegistry'
import { SANDBOXED_REFUSAL } from '../sandbox/sandboxedCaller'
import type { PaneWaking } from './paneWaking'

export const READ_LINES_DEFAULT = 200
export const READ_LINES_MAX = 2000
export const INPUT_MAX_LENGTH = 16 * 1024
export const PASTE_SETTLE_MS = 100
export const CONFIRM_DEFAULT_MS = 2000
export const CONFIRM_MAX_MS = 10_000
const WAKE_WAIT_MIN_MS = 1000
const WAKE_WAIT_DEFAULT_MS = 2 * 60_000
const WAKE_WAIT_MAX_MS = 30 * 60_000
const CONFIRM_POLL_MS = 50
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

const NAMED_KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  tab: '\t',
  'shift-tab': '\x1b[Z',
  escape: '\x1b',
  backspace: '\x7f',
  delete: '\x1b[3~',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
}

const CTRL_LETTER = /^ctrl-([a-z])$/

export const INPUT_KEY_NAMES = [...Object.keys(NAMED_KEYS), 'ctrl-a..ctrl-z'].join(', ')

export interface PaneIo {
  read: (paneId: string, lines: number) => Promise<string | null>
  write: (paneId: string, data: string) => boolean
  bracketedPaste: (paneId: string) => boolean
  outputCursor: (paneId: string) => number | undefined
}

export interface PaneAttentionPeek {
  state?: string
  message?: string
}

export function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

export function record(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

export function keyBytes(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined
  const dashed = key.trim().toLowerCase().replaceAll('+', '-')
  const name = KEY_ALIASES[dashed] ?? dashed
  const letter = CTRL_LETTER.exec(name)?.[1]
  if (letter) return String.fromCharCode(letter.charCodeAt(0) - 96)
  return Object.hasOwn(NAMED_KEYS, name) ? NAMED_KEYS[name] : undefined
}

export function inputParts(text: unknown, keys: unknown): { text: string; keys: string } {
  const parts = { text: '', keys: '' }
  if (text !== undefined) {
    if (typeof text !== 'string') throw fail('bad-request: text')
    parts.text = text
  }
  if (keys !== undefined) {
    if (!Array.isArray(keys)) throw fail('bad-request: keys')
    for (const key of keys) {
      const bytes = keyBytes(key)
      if (bytes === undefined) {
        throw fail(`unknown-key: ${String(key)} (known: ${INPUT_KEY_NAMES})`)
      }
      parts.keys += bytes
    }
  }
  if (!parts.text && !parts.keys) throw fail('bad-request: text or keys')
  if (parts.text.length + parts.keys.length > INPUT_MAX_LENGTH) throw fail('too-long: input')
  return parts
}

export function inputBytes(text: unknown, keys: unknown): string {
  const parts = inputParts(text, keys)
  return parts.text + parts.keys
}

export function pasteBytes(text: string): string {
  const body = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '')
  return `${PASTE_START}${body.replace(/\r?\n/g, '\r')}${PASTE_END}`
}

export function pastedText(bytes: string): string | null {
  if (!bytes.startsWith(PASTE_START) || !bytes.endsWith(PASTE_END)) return null
  const body = bytes.slice(PASTE_START.length, bytes.length - PASTE_END.length)
  return body.includes(PASTE_START) || body.includes(PASTE_END) ? null : body
}

function optionalFlag(raw: unknown, name: string): boolean | undefined {
  if (raw === undefined) return undefined
  if (typeof raw !== 'boolean') throw fail(`bad-request: ${name}`)
  return raw
}

export function confirmWindow(raw: unknown): number {
  if (raw === undefined) return CONFIRM_DEFAULT_MS
  const ms = Number(raw)
  if (!Number.isInteger(ms) || ms < 0) throw fail('bad-request: confirmMs')
  return Math.min(ms, CONFIRM_MAX_MS)
}

function wakeWaitTimeout(raw: unknown): number {
  if (raw === undefined) return WAKE_WAIT_DEFAULT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw fail('bad-request: timeoutMs')
  return Math.min(WAKE_WAIT_MAX_MS, Math.max(WAKE_WAIT_MIN_MS, raw))
}

export function readLineCount(raw: unknown): number {
  const n = raw === undefined ? READ_LINES_DEFAULT : Number(raw)
  if (!Number.isInteger(n) || n < 1) throw fail('bad-request: lines')
  return Math.min(n, READ_LINES_MAX)
}

export type PaneReach = 'input' | 'read' | 'close' | 'move'

export interface ReachFacts {
  caller: { paneId: string; workspaceId: string; sandboxed: boolean }
  target: { paneId: string; workspaceId: string; manager: boolean; confined: boolean }
  ownChild: boolean
  sameScope: boolean
}

export type ReachVerdict = { allowed: true; caps: Capability[] } | { allowed: false; error: string }

const REACH_CAPS: Readonly<Record<PaneReach, Capability>> = {
  input: 'type-other-pane',
  read: 'read-other-pane',
  close: 'kill-pane',
  move: 'type-other-pane',
}

export function paneReach(kind: PaneReach, facts: ReachFacts): ReachVerdict {
  const { caller, target } = facts
  if (target.manager) return { allowed: false, error: 'unknown-pane' }
  if (caller.paneId === target.paneId && kind !== 'close') {
    return kind === 'input' ? { allowed: false, error: 'own-pane' } : { allowed: true, caps: [] }
  }
  const sameWorkspace = caller.workspaceId === target.workspaceId
  if (caller.sandboxed && !(sameWorkspace && target.confined)) {
    return { allowed: false, error: 'sandboxed' }
  }
  const sameScope = sameWorkspace || facts.sameScope
  if (facts.ownChild && sameScope) return { allowed: true, caps: ['process'] }
  return {
    allowed: true,
    caps: [REACH_CAPS[kind], ...(sameScope ? [] : (['all-workspaces'] as const))],
  }
}

export interface PaneReachDeps {
  processPane: (ref: string, ctx: ControlMethodContext) => Promise<string | undefined>
  inScope: Reach['inScope']
  isChild: (ownerPaneId: string, paneId: string) => boolean
  isSandboxed: (workspaceId: string) => boolean
  isConfined: (paneId: string) => boolean
}

export interface PaneIoDeps extends PaneReachDeps {
  io: PaneIo
  state: (paneId: string) => TerminalStateSnapshot | undefined
  managerAllowsInput: () => boolean
  attention: (pane: PaneIdentity) => Promise<PaneAttentionPeek>
  inputSent: (pane: PaneIdentity) => void
  hibernated: (pane: PaneIdentity) => Promise<boolean>
  wake: (pane: PaneIdentity) => Promise<boolean>
  waking: PaneWaking
  close: (pane: PaneIdentity) => Promise<CommandResult>
  resume: (pane: PaneIdentity) => Promise<CommandResult>
  delay: (ms: number) => Promise<void>
}

const REFUSALS: Readonly<Record<string, string>> = {
  'own-pane': 'own-pane: a pane cannot type into itself',
  sandboxed: SANDBOXED_REFUSAL,
}

const PANE_REFS_MAX = 32

function asleep(to: PaneIdentity): ResponseError<void> {
  return fail(`hibernated: ${to.externalId} is asleep; wake it with ostia pane wake`)
}

function starting(to: PaneIdentity): ResponseError<void> {
  return fail(
    `waking: ${to.externalId} is starting its agent; wait for it with ostia pane wake --wait`,
  )
}

function notHibernated(to: PaneIdentity): ResponseError<void> {
  return fail(`not-hibernated: ${to.externalId} is not hibernated`)
}

export function paneRefs(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw fail('bad-request: panes')
  if (raw.length > PANE_REFS_MAX) throw fail('too-many: panes')
  if (!raw.every((ref) => typeof ref === 'string' && ref)) throw fail('bad-request: panes')
  return [...new Set(raw as string[])]
}

export async function paneTarget(
  deps: Pick<PaneReachDeps, 'processPane'>,
  raw: unknown,
  ctx: ControlMethodContext,
): Promise<PaneIdentity> {
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: pane')
  const processPane = await deps.processPane(raw, ctx)
  const found = processPane ? getByPaneId(processPane) : resolveExternal(raw)
  if (found?.kind !== 'pane') throw fail(`unknown-pane: ${raw}`)
  return found
}

export async function ensurePaneReach(
  deps: PaneReachDeps,
  kind: PaneReach,
  to: PaneIdentity,
  ctx: ControlMethodContext,
  ask: { ref: string; method: string; detail: string },
): Promise<void> {
  const me = ctx.identity
  const sandboxed = deps.isSandboxed(me.workspaceId)
  const sameScope = !sandboxed && to.manager !== true && (await deps.inScope(ctx, to.workspaceId))
  const verdict = paneReach(kind, {
    caller: {
      paneId: me.paneId,
      workspaceId: me.workspaceId,
      sandboxed,
    },
    target: {
      paneId: to.paneId,
      workspaceId: to.workspaceId,
      manager: to.manager === true,
      confined: deps.isConfined(to.paneId),
    },
    ownChild: deps.isChild(me.paneId, to.paneId),
    sameScope,
  })
  if (!verdict.allowed) {
    throw fail(
      verdict.error === 'unknown-pane' ? `unknown-pane: ${ask.ref}` : REFUSALS[verdict.error],
    )
  }
  await ensureCaps(ctx.authed, me, verdict.caps, ask.method, ask.detail)
}

export function registerPaneIoMethods(deps: PaneIoDeps): void {
  const target = (raw: unknown, ctx: ControlMethodContext): Promise<PaneIdentity> =>
    paneTarget(deps, raw, ctx)

  const reach = (
    kind: PaneReach,
    to: PaneIdentity,
    ref: string,
    ctx: ControlMethodContext,
    detail: string,
  ): Promise<void> => ensurePaneReach(deps, kind, to, ctx, { ref, method: `pane.${kind}`, detail })

  const ensureManagerInput = (ctx: ControlMethodContext): void => {
    if (ctx.identity.manager && !deps.managerAllowsInput()) {
      throw fail(
        'input-off: typing into panes is off; the human can turn on manager.allowInput in Settings → Manager',
      )
    }
  }

  const respondedSince = async (paneId: string, before: number | undefined, ms: number) => {
    if (before === undefined) return false
    for (let waited = 0; ; waited += CONFIRM_POLL_MS) {
      const now = deps.io.outputCursor(paneId)
      if (now !== undefined && now > before) return true
      if (waited >= ms) return false
      await deps.delay(CONFIRM_POLL_MS)
    }
  }

  registerControlMethod('pane.input', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const to = await target(p.pane, ctx)
      const parts = inputParts(p.text, p.keys)
      const paste = optionalFlag(p.paste, 'paste') ?? parts.text.includes('\n')
      const force = optionalFlag(p.force, 'force') === true
      const confirm = optionalFlag(p.confirm, 'confirm') === true
      const confirmMs = confirmWindow(p.confirmMs)
      ensureManagerInput(ctx)
      const shown = [
        ...(typeof p.text === 'string' ? [JSON.stringify(p.text)] : []),
        ...(Array.isArray(p.keys) ? p.keys.map(String) : []),
      ].join(' ')
      await reach('input', to, String(p.pane), ctx, `type into ${to.externalId}: ${shown}`)
      if (await deps.hibernated(to)) throw asleep(to)
      if (deps.waking.has(to.paneId)) throw starting(to)
      if (parts.text && !force) {
        const attention = await deps.attention(to)
        if (attention.state === 'waiting') {
          const why = attention.message ? `: ${attention.message}` : ''
          throw fail(
            `agent-waiting: ${to.externalId} is waiting for the human${why}. Answer it with keys, or pass force to type anyway`,
          )
        }
      }
      const pasted = paste && parts.text !== '' && deps.io.bracketedPaste(to.paneId)
      const before = deps.io.outputCursor(to.paneId)
      const text = pasted ? pasteBytes(parts.text) : parts.text
      const first = text || parts.keys
      const rest = text ? parts.keys : ''
      if (!deps.io.write(to.paneId, first)) {
        throw fail(`no-terminal: ${to.externalId} has no running terminal`)
      }
      if (rest) {
        await deps.delay(PASTE_SETTLE_MS)
        if (!deps.io.write(to.paneId, rest)) {
          throw fail(`no-terminal: ${to.externalId} closed before the keys after the text`)
        }
      }
      deps.inputSent(to)
      const result = { ok: true, paneId: to.externalId, bytes: first.length + rest.length, pasted }
      if (!confirm) return result
      return { ...result, responded: await respondedSince(to.paneId, before, confirmMs) }
    },
  })

  registerControlMethod('pane.wake', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const refs = paneRefs(p.panes)
      const wait = optionalFlag(p.wait, 'wait') === true
      const timeoutMs = wakeWaitTimeout(p.timeoutMs)
      ensureManagerInput(ctx)
      const panes: PaneIdentity[] = []
      const asleepPanes: PaneIdentity[] = []
      for (const ref of refs) {
        const to = await target(ref, ctx)
        await ensurePaneReach(deps, 'input', to, ctx, {
          ref,
          method: 'pane.wake',
          detail: `wake ${to.externalId}: type its agent's resume command`,
        })
        panes.push(to)
        if (wait && deps.waking.has(to.paneId)) continue
        if (!(await deps.hibernated(to))) throw notHibernated(to)
        asleepPanes.push(to)
      }
      const woke: string[] = []
      for (const to of asleepPanes) {
        if (!(await deps.wake(to))) throw notHibernated(to)
        deps.waking.start(to.paneId)
        woke.push(to.externalId)
      }
      if (!wait) return { ok: true, woke }
      const ended = await deps.waking.until(
        panes.map((to) => to.paneId),
        timeoutMs,
        (cancel) => ctx.conn.onClose(cancel),
      )
      const external = (paneId: string): string =>
        panes.find((to) => to.paneId === paneId)?.externalId ?? paneId
      if (ended.how === 'started') return { ok: true, woke, started: true }
      if (ended.how === 'timeout') return { ok: true, woke, timedOut: true }
      if (ended.how === 'closed') return { ok: true, woke, closed: external(ended.paneId) }
      throw fail(
        `resume-failed: ${external(ended.paneId)} could not start its agent; read it with ostia pane read`,
      )
    },
  })

  registerControlMethod('agent.resume', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const to = await target(p.pane, ctx)
      ensureManagerInput(ctx)
      await ensurePaneReach(deps, 'input', to, ctx, {
        ref: String(p.pane),
        method: 'agent.resume',
        detail: `resume the agent of ${to.externalId}: type its recorded resume command`,
      })
      if (deps.waking.has(to.paneId)) throw starting(to)
      const res = await deps.resume(to)
      if (!res.ok) throw fail(res.error.message)
      const resumed = (res.result as { resumed?: unknown } | undefined)?.resumed === true
      return { ok: true, paneId: to.externalId, resumed }
    },
  })

  registerControlMethod('pane.close', {
    scripts: true,
    handler: async (raw, ctx) => {
      const refs = paneRefs(record(raw).panes)
      const panes: PaneIdentity[] = []
      for (const ref of refs) {
        const to = await target(ref, ctx)
        await ensurePaneReach(deps, 'close', to, ctx, {
          ref,
          method: 'pane.close',
          detail: `close ${to.externalId}`,
        })
        panes.push(to)
      }
      const closed: string[] = []
      for (const to of panes) {
        const res = await deps.close(to)
        if (!res.ok) throw fail(res.error.message)
        closed.push(to.externalId)
      }
      return { ok: true, closed }
    },
  })

  registerControlMethod('pane.read', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const to = await target(p.pane, ctx)
      const lines = readLineCount(p.lines)
      await reach('read', to, String(p.pane), ctx, `read the screen of ${to.externalId}`)
      const text = await deps.io.read(to.paneId, lines)
      if (text === null) throw fail(`no-terminal: ${to.externalId} has no running terminal`)
      const state = deps.state(to.paneId)
      return {
        paneId: to.externalId,
        text,
        cwd: state?.cwd,
        running: state?.running ?? false,
        lastExitCode: state?.lastExitCode,
      }
    },
  })
}
