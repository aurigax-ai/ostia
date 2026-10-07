import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import type { TerminalStateSnapshot } from '../shared/types'
import { ensureCaps } from './controlElevation'
import { type ControlMethodContext, registerControlMethod } from './controlServer'
import { type PaneIdentity, getByPaneId, resolveExternal } from './idRegistry'

export const READ_LINES_DEFAULT = 200
export const READ_LINES_MAX = 2000
export const INPUT_MAX_LENGTH = 16 * 1024
export const PASTE_SETTLE_MS = 100
export const CONFIRM_DEFAULT_MS = 2000
export const CONFIRM_MAX_MS = 10_000
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

function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function record(raw: unknown): Record<string, unknown> {
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

export function readLineCount(raw: unknown): number {
  const n = raw === undefined ? READ_LINES_DEFAULT : Number(raw)
  if (!Number.isInteger(n) || n < 1) throw fail('bad-request: lines')
  return Math.min(n, READ_LINES_MAX)
}

export type PaneReach = 'input' | 'read'

export interface ReachFacts {
  caller: { paneId: string; workspaceId: string; sandboxed: boolean }
  target: { paneId: string; workspaceId: string; manager: boolean; confined: boolean }
  ownChild: boolean
}

export type ReachVerdict = { allowed: true; caps: Capability[] } | { allowed: false; error: string }

export function paneReach(kind: PaneReach, facts: ReachFacts): ReachVerdict {
  const { caller, target } = facts
  if (target.manager) return { allowed: false, error: 'unknown-pane' }
  if (caller.paneId === target.paneId) {
    return kind === 'read' ? { allowed: true, caps: [] } : { allowed: false, error: 'own-pane' }
  }
  const sameWorkspace = caller.workspaceId === target.workspaceId
  if (caller.sandboxed && !(sameWorkspace && target.confined)) {
    return { allowed: false, error: 'sandboxed' }
  }
  if (facts.ownChild && sameWorkspace) return { allowed: true, caps: ['process'] }
  return {
    allowed: true,
    caps: [
      kind === 'input' ? 'type-other-pane' : 'read-other-pane',
      ...(sameWorkspace ? [] : (['all-workspaces'] as const)),
    ],
  }
}

export interface PaneReachDeps {
  processPane: (ref: string, ctx: ControlMethodContext) => string | undefined
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
  delay: (ms: number) => Promise<void>
}

const REFUSALS: Readonly<Record<string, string>> = {
  'own-pane': 'own-pane: a pane cannot type into itself',
  sandboxed:
    'sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace',
}

export function paneTarget(
  deps: Pick<PaneReachDeps, 'processPane'>,
  raw: unknown,
  ctx: ControlMethodContext,
): PaneIdentity {
  if (typeof raw !== 'string' || !raw) throw fail('bad-request: pane')
  const processPane = deps.processPane(raw, ctx)
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
  const verdict = paneReach(kind, {
    caller: {
      paneId: me.paneId,
      workspaceId: me.workspaceId,
      sandboxed: deps.isSandboxed(me.workspaceId),
    },
    target: {
      paneId: to.paneId,
      workspaceId: to.workspaceId,
      manager: to.manager === true,
      confined: deps.isConfined(to.paneId),
    },
    ownChild: deps.isChild(me.paneId, to.paneId),
  })
  if (!verdict.allowed) {
    throw fail(
      verdict.error === 'unknown-pane' ? `unknown-pane: ${ask.ref}` : REFUSALS[verdict.error],
    )
  }
  await ensureCaps(ctx.authed, me, verdict.caps, ask.method, ask.detail)
}

export function registerPaneIoMethods(deps: PaneIoDeps): void {
  const target = (raw: unknown, ctx: ControlMethodContext): PaneIdentity =>
    paneTarget(deps, raw, ctx)

  const reach = (
    kind: PaneReach,
    to: PaneIdentity,
    ref: string,
    ctx: ControlMethodContext,
    detail: string,
  ): Promise<void> => ensurePaneReach(deps, kind, to, ctx, { ref, method: `pane.${kind}`, detail })

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
      const to = target(p.pane, ctx)
      const parts = inputParts(p.text, p.keys)
      const paste = optionalFlag(p.paste, 'paste') ?? parts.text.includes('\n')
      const force = optionalFlag(p.force, 'force') === true
      const confirm = optionalFlag(p.confirm, 'confirm') === true
      const confirmMs = confirmWindow(p.confirmMs)
      if (ctx.identity.manager && !deps.managerAllowsInput()) {
        throw fail(
          'input-off: typing into panes is off; the human can turn on manager.allowInput in Settings → Manager',
        )
      }
      const shown = [
        ...(typeof p.text === 'string' ? [JSON.stringify(p.text)] : []),
        ...(Array.isArray(p.keys) ? p.keys.map(String) : []),
      ].join(' ')
      await reach('input', to, String(p.pane), ctx, `type into ${to.externalId}: ${shown}`)
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
      const first = pasted ? pasteBytes(parts.text) : parts.text + parts.keys
      const rest = pasted ? parts.keys : ''
      if (!deps.io.write(to.paneId, first)) {
        throw fail(`no-terminal: ${to.externalId} has no running terminal`)
      }
      if (rest) {
        await deps.delay(PASTE_SETTLE_MS)
        if (!deps.io.write(to.paneId, rest)) {
          throw fail(`no-terminal: ${to.externalId} closed before the keys after the paste`)
        }
      }
      deps.inputSent(to)
      const result = { ok: true, paneId: to.externalId, bytes: first.length + rest.length, pasted }
      if (!confirm) return result
      return { ...result, responded: await respondedSince(to.paneId, before, confirmMs) }
    },
  })

  registerControlMethod('pane.read', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const to = target(p.pane, ctx)
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
