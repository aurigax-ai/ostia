import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { ManagerSettings } from '../shared/managerSettings'
import { type ControlMethod, registerControlMethod } from './controlServer'
import { type PaneIdentity, resolveExternal } from './idRegistry'

export const READ_LINES_DEFAULT = 200
export const READ_LINES_MAX = 2000
export const INPUT_MAX_LENGTH = 16 * 1024
const SPAWN_WINDOW_MS = 10 * 60 * 1000
const BUS_WINDOW_MS = 60 * 1000

export const INPUT_KEYS: Readonly<Record<string, string>> = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  'ctrl-d': '\x04',
}

export interface WorkerRequest {
  argv: string[]
  cwd?: string
  workspaceId?: string
  name?: string
}

export interface ManagerMethodDeps {
  settings: () => ManagerSettings
  agents: () => Record<string, string[]>
  readPane: (paneId: string, lines: number) => Promise<string | null>
  writePane: (paneId: string, data: string) => boolean
  openWorker: (req: WorkerRequest) => Promise<string | null>
  paneAlive: (paneId: string) => boolean
  now: () => number
}

export class RateWindow {
  private readonly stamps: number[] = []

  constructor(private readonly windowMs: number) {}

  take(limit: number, now: number): boolean {
    while (this.stamps.length > 0 && now - (this.stamps[0] ?? 0) >= this.windowMs) {
      this.stamps.shift()
    }
    if (this.stamps.length >= limit) return false
    this.stamps.push(now)
    return true
  }
}

function fail(message: string): ResponseError<void> {
  return new ResponseError(ErrorCodes.InvalidRequest, message)
}

function params(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function targetPane(raw: unknown, me: PaneIdentity): PaneIdentity {
  if (typeof raw !== 'string') throw fail('bad-request: paneId')
  const target = resolveExternal(raw)
  if (target?.kind !== 'pane') throw fail(`unknown-pane: ${raw}`)
  if (target.paneId === me.paneId) throw fail('own-pane: the manager cannot act on its own pane')
  return target
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
      const bytes = typeof key === 'string' ? INPUT_KEYS[key] : undefined
      if (bytes === undefined) {
        throw fail(`unknown-key: ${String(key)} (known: ${Object.keys(INPUT_KEYS).join(', ')})`)
      }
      data += bytes
    }
  }
  if (!data) throw fail('bad-request: text or keys')
  if (data.length > INPUT_MAX_LENGTH) throw fail('too-long: input')
  return data
}

export interface ManagerLimiter {
  busAllowed: () => boolean
}

export function registerManagerMethods(deps: ManagerMethodDeps): ManagerLimiter {
  const workers = new Set<string>()
  const spawns = new RateWindow(SPAWN_WINDOW_MS)
  const busSends = new RateWindow(BUS_WINDOW_MS)

  const managerOnly = (method: Omit<ControlMethod, 'callers'>): ControlMethod => ({
    ...method,
    callers: 'manager',
  })

  registerControlMethod(
    'manager.read',
    managerOnly({
      handler: async (raw, ctx) => {
        const p = params(raw)
        const target = targetPane(p.paneId, ctx.identity)
        const n = p.lines === undefined ? READ_LINES_DEFAULT : Number(p.lines)
        if (!Number.isInteger(n) || n < 1) throw fail('bad-request: lines')
        const text = await deps.readPane(target.paneId, Math.min(n, READ_LINES_MAX))
        if (text === null) throw fail(`no-terminal: ${target.externalId} has no running terminal`)
        return { paneId: target.externalId, text }
      },
    }),
  )

  registerControlMethod(
    'manager.spawn',
    managerOnly({
      handler: async (raw) => {
        const p = params(raw)
        if (typeof p.agent !== 'string') throw fail('bad-request: agent')
        const agents = deps.agents()
        const preset = agents[p.agent]
        if (!preset) {
          throw fail(`unknown-agent: ${p.agent} (known: ${Object.keys(agents).join(', ')})`)
        }
        const args = p.args ?? []
        if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
          throw fail('bad-request: args')
        }
        if (p.cwd !== undefined && (typeof p.cwd !== 'string' || !p.cwd.startsWith('/'))) {
          throw fail('bad-request: cwd')
        }
        if (p.workspaceId !== undefined && typeof p.workspaceId !== 'string') {
          throw fail('bad-request: workspaceId')
        }
        if (p.name !== undefined && typeof p.name !== 'string') throw fail('bad-request: name')
        const { limits } = deps.settings()
        for (const id of workers) if (!deps.paneAlive(id)) workers.delete(id)
        if (workers.size >= limits.maxWorkers) {
          throw fail(`limit: ${limits.maxWorkers} workers are already running`)
        }
        if (!spawns.take(limits.spawnsPer10Min, deps.now())) {
          throw fail(`limit: at most ${limits.spawnsPer10Min} workers per 10 minutes`)
        }
        const paneId = await deps.openWorker({
          argv: [...preset, ...(args as string[])],
          ...(p.cwd === undefined ? {} : { cwd: p.cwd as string }),
          ...(p.workspaceId === undefined ? {} : { workspaceId: p.workspaceId as string }),
          ...(p.name === undefined ? {} : { name: p.name as string }),
        })
        if (!paneId) throw fail('spawn-failed: Pine could not open the worker')
        const identity = resolveExternal(paneId)
        if (identity?.kind === 'pane') workers.add(identity.paneId)
        return { paneId }
      },
    }),
  )

  registerControlMethod(
    'manager.input',
    managerOnly({
      handler: (raw, ctx) => {
        if (!deps.settings().allowInput) {
          throw fail(
            'input-off: typing into panes is off; the human can turn on manager.allowInput in Settings → Manager',
          )
        }
        const p = params(raw)
        const target = targetPane(p.paneId, ctx.identity)
        const data = inputBytes(p.text, p.keys)
        if (!deps.writePane(target.paneId, data)) {
          throw fail(`no-terminal: ${target.externalId} has no running terminal`)
        }
        return { ok: true }
      },
    }),
  )

  return {
    busAllowed: () => busSends.take(deps.settings().limits.busPerMinute, deps.now()),
  }
}
