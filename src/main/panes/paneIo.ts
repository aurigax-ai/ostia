import type { ResponseError } from 'vscode-jsonrpc/node'
import type { CommandResult } from '../../shared/control/commands'
import { shortId } from '../../shared/panes/paneStatus'
import type { TerminalStateSnapshot } from '../../shared/terminal/ptyApi'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { type CloseFinishedDeps, closeFinished } from './paneCloseFinished'
import { CONFIRM_MAX_MS, createPaneConfirms } from './paneConfirm'
import { ensurePaneReach, fail, type PaneReach, paneRefs, paneTarget, record } from './paneReach'
import { refFailure, resolvePaneRef } from './paneRef'
import { type PaneWakeDeps, registerPaneWakeMethods } from './paneWakeMethods'

const READ_LINES_DEFAULT = 200
const READ_LINES_MAX = 2000
const INPUT_MAX_LENGTH = 16 * 1024
const PASTE_SETTLE_MS = 100
const CONFIRM_DEFAULT_MS = 2000
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

const INPUT_KEY_NAMES = [...Object.keys(NAMED_KEYS), 'ctrl-a..ctrl-z'].join(', ')

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

export function keyBytes(key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined
  const dashed = key.trim().toLowerCase().replaceAll('+', '-')
  const name = KEY_ALIASES[dashed] ?? dashed
  const letter = CTRL_LETTER.exec(name)?.[1]
  if (letter) return String.fromCharCode(letter.charCodeAt(0) - 96)
  return Object.hasOwn(NAMED_KEYS, name) ? NAMED_KEYS[name] : undefined
}

function inputParts(text: unknown, keys: unknown): { text: string; keys: string } {
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

function confirmWindow(raw: unknown): number {
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

export interface PaneIoDeps
  extends PaneWakeDeps,
    Pick<CloseFinishedDeps, 'lifecycle' | 'childrenOf' | 'closeBlock'> {
  io: PaneIo
  state: (paneId: string) => TerminalStateSnapshot | undefined
  managerAllowsInput: () => boolean
  attention: (pane: PaneIdentity) => Promise<PaneAttentionPeek>
  inputSent: (pane: PaneIdentity) => void
  close: (pane: PaneIdentity) => Promise<CommandResult>
  delay: (ms: number) => Promise<void>
  hooksOn: (agent: string) => boolean
}

function asleep(to: PaneIdentity): ResponseError<void> {
  const id = shortId(to.externalId)
  return fail(
    `hibernated: ${to.externalId} is asleep; wake it with ostia pane wake ${id} (ostia bus send ${id} "<text>" wakes it too if you hold pane wake's reach)`,
  )
}

function starting(to: PaneIdentity): ResponseError<void> {
  return fail(
    `waking: ${to.externalId} is starting its agent; wait for it with ostia pane wake ${shortId(to.externalId)}`,
  )
}

function noTerminal(to: PaneIdentity, why: string): ResponseError<void> {
  return fail(
    `no-terminal: ${to.externalId} ${why}; see it with ostia pane status ${shortId(to.externalId)}`,
  )
}

export function registerPaneIoMethods(deps: PaneIoDeps): void {
  const target = (
    raw: unknown,
    ctx: ControlMethodContext,
    destructive = false,
  ): Promise<PaneIdentity> => paneTarget(deps, raw, ctx, destructive)

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

  const { confirmGone, confirmInput, confirmSubmitted, watchesSubmit } = createPaneConfirms(deps)

  registerControlMethod('pane.input', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const to = await target(p.pane, ctx, true)
      const parts = inputParts(p.text, p.keys)
      const paste = optionalFlag(p.paste, 'paste') ?? parts.text.includes('\n')
      const force = optionalFlag(p.force, 'force') === true
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
      const submits = parts.text !== '' && parts.keys.endsWith(NAMED_KEYS.enter)
      const watched = submits && (await watchesSubmit(to))
      const pasted = paste && parts.text !== '' && deps.io.bracketedPaste(to.paneId)
      const before = deps.io.outputCursor(to.paneId)
      const text = pasted ? pasteBytes(parts.text) : parts.text
      const first = text || parts.keys
      const rest = text ? parts.keys : ''
      if (!deps.io.write(to.paneId, first)) {
        throw noTerminal(to, 'has no running terminal')
      }
      if (rest) {
        await deps.delay(PASTE_SETTLE_MS)
        if (!deps.io.write(to.paneId, rest)) {
          throw noTerminal(to, 'closed before the keys after the text')
        }
      }
      deps.inputSent(to)
      const responded = await confirmInput(to, before, confirmMs)
      if (responded && watched) {
        const submitted = await confirmSubmitted(to)
        if (!submitted.ok) throw fail(submitted.reason)
      }
      const state = deps.state(to.paneId)
      return {
        ok: true,
        paneId: to.externalId,
        bytes: first.length + rest.length,
        pasted,
        responded,
        turnStarted: watched && responded,
        running: state?.running ?? false,
      }
    },
  })

  registerPaneWakeMethods({ ...deps, target, ensureManagerInput })

  registerControlMethod('pane.close', {
    scripts: true,
    handler: async (raw, ctx) => {
      if (record(raw).finished === true) {
        return closeFinished({ ...deps, confirmGone }, ctx)
      }
      const given = record(raw).panes
      const own = given === undefined && ctx.identity.kind === 'pane'
      const refs = own ? [ctx.identity.externalId] : paneRefs(given)
      const panes: PaneIdentity[] = []
      const already: { paneId: string; closedAt: number; name?: string }[] = []
      for (const ref of refs) {
        const resolved = await resolvePaneRef(deps, ref, ctx, true)
        if ('closed' in resolved) {
          const { externalId: paneId, closedAt, name } = resolved.closed
          already.push({ paneId, closedAt, ...(name ? { name } : {}) })
          continue
        }
        if (!('found' in resolved)) throw fail(refFailure(ref, resolved))
        const to = resolved.found
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
        const gone = await confirmGone(to)
        if (!gone.ok) throw fail(gone.reason)
        closed.push(to.externalId)
      }
      return { ok: true, closed, already }
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
      if (text === null && (await deps.hibernated(to))) throw asleep(to)
      if (text === null) throw noTerminal(to, 'has no running terminal')
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
