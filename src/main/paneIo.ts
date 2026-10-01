import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { Capability } from '../shared/capabilities'
import type { TerminalStateSnapshot } from '../shared/types'
import { ensureCaps } from './controlElevation'
import { type ControlMethodContext, registerControlMethod } from './controlServer'
import { type PaneIdentity, getByPaneId, resolveExternal } from './idRegistry'

export const READ_LINES_DEFAULT = 200
export const READ_LINES_MAX = 2000
export const INPUT_MAX_LENGTH = 16 * 1024

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

export function inputBytes(text: unknown, keys: unknown): string {
  let data = ''
  if (text !== undefined) {
    if (typeof text !== 'string') throw fail('bad-request: text')
    data += text
  }
  if (keys !== undefined) {
    if (!Array.isArray(keys)) throw fail('bad-request: keys')
    for (const key of keys) {
      const bytes = keyBytes(key)
      if (bytes === undefined) {
        throw fail(`unknown-key: ${String(key)} (known: ${INPUT_KEY_NAMES})`)
      }
      data += bytes
    }
  }
  if (!data) throw fail('bad-request: text or keys')
  if (data.length > INPUT_MAX_LENGTH) throw fail('too-long: input')
  return data
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

export interface PaneIoDeps {
  io: PaneIo
  state: (paneId: string) => TerminalStateSnapshot | undefined
  processPane: (ref: string, ctx: ControlMethodContext) => string | undefined
  isChild: (ownerPaneId: string, paneId: string) => boolean
  isSandboxed: (workspaceId: string) => boolean
  isConfined: (paneId: string) => boolean
  managerAllowsInput: () => boolean
}

const REFUSALS: Readonly<Record<string, string>> = {
  'own-pane': 'own-pane: a pane cannot type into itself',
  sandboxed:
    'sandboxed: a sandboxed workspace reaches only the sandboxed terminals of its own workspace',
}

export function registerPaneIoMethods(deps: PaneIoDeps): void {
  const target = (raw: unknown, ctx: ControlMethodContext): PaneIdentity => {
    if (typeof raw !== 'string' || !raw) throw fail('bad-request: pane')
    const processPane = deps.processPane(raw, ctx)
    const found = processPane ? getByPaneId(processPane) : resolveExternal(raw)
    if (found?.kind !== 'pane') throw fail(`unknown-pane: ${raw}`)
    return found
  }

  const reach = async (
    kind: PaneReach,
    to: PaneIdentity,
    ref: string,
    ctx: ControlMethodContext,
    detail: string,
  ): Promise<void> => {
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
        verdict.error === 'unknown-pane' ? `unknown-pane: ${ref}` : REFUSALS[verdict.error],
      )
    }
    await ensureCaps(ctx.authed, me, verdict.caps, `pane.${kind}`, detail)
  }

  registerControlMethod('pane.input', {
    handler: async (raw, ctx) => {
      const p = record(raw)
      const to = target(p.pane, ctx)
      const data = inputBytes(p.text, p.keys)
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
      if (!deps.io.write(to.paneId, data)) {
        throw fail(`no-terminal: ${to.externalId} has no running terminal`)
      }
      return { ok: true, paneId: to.externalId }
    },
  })

  registerControlMethod('pane.read', {
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
