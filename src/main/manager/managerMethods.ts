import { ErrorCodes, ResponseError } from 'vscode-jsonrpc/node'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import { type ControlMethod, registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import { type PaneIo, inputBytes, readLineCount } from '../panes/paneIo'
import { RateWindow } from '../platform/rateWindow'

const SPAWN_WINDOW_MS = 10 * 60 * 1000
const BUS_WINDOW_MS = 60 * 1000

export interface WorkerRequest {
  argv: string[]
  cwd?: string
  workspaceId?: string
  name?: string
}

export interface ManagerMethodDeps {
  settings: () => ManagerSettings
  agents: () => Record<string, string[]>
  io: PaneIo
  openWorker: (req: WorkerRequest) => Promise<string | null>
  paneAlive: (paneId: string) => boolean
  now: () => number
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
        const text = await deps.io.read(target.paneId, readLineCount(p.lines))
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
        if (!paneId) throw fail(`spawn-failed: ${PRODUCT_DISPLAY_NAME} could not open the worker`)
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
        if (!deps.io.write(target.paneId, data)) {
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
