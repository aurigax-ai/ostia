import type { AttentionState } from '../../shared/attention/attention'
import type { PaneStatus } from '../../shared/panes/paneStatus'
import { clampMessage } from '../attention/attention'
import { registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import type { PaneAttentionPeek } from './paneIo'
import { ensurePaneReach, fail, type PaneReachDeps, paneTarget, record } from './paneReach'

const PANE_WAIT_STATES = ['done', 'waiting', 'error', 'idle', 'exited', 'command'] as const
export type PaneWaitState = (typeof PANE_WAIT_STATES)[number]
const PANE_WAIT_DEFAULT_UNTIL: readonly PaneWaitState[] = ['done', 'waiting', 'exited']
const PANE_WAIT_MIN_MS = 1000
const PANE_WAIT_DEFAULT_MS = 10 * 60_000
const PANE_WAIT_MAX_MS = 30 * 60_000
const PANE_WAIT_MAX_PANES = 32

const ATTENTION_STATES: ReadonlySet<string> = new Set<AttentionState>([
  'none',
  'working',
  'waiting',
  'done',
  'error',
])

type PaneChange =
  | { kind: 'attention'; attention: PaneAttentionPeek }
  | { kind: 'state' }
  | { kind: 'closed' }

type PaneListener = (change: PaneChange) => void

export class PaneWatch {
  private readonly listeners = new Map<string, Set<PaneListener>>()
  private readonly taps = new Set<(paneId: string, change: PaneChange) => void>()

  tap(listener: (paneId: string, change: PaneChange) => void): void {
    this.taps.add(listener)
  }

  watch(paneId: string, listener: PaneListener): () => void {
    const set = this.listeners.get(paneId) ?? new Set()
    set.add(listener)
    this.listeners.set(paneId, set)
    return () => {
      set.delete(listener)
      if (set.size === 0 && this.listeners.get(paneId) === set) this.listeners.delete(paneId)
    }
  }

  emit(paneId: string, change: PaneChange): void {
    for (const tap of this.taps) tap(paneId, change)
    for (const listener of [...(this.listeners.get(paneId) ?? [])]) listener(change)
  }

  attention(paneId: string, state: unknown, message: unknown): void {
    if (typeof state !== 'string' || !ATTENTION_STATES.has(state)) return
    const text = clampMessage(message)
    this.emit(paneId, {
      kind: 'attention',
      attention: state === 'none' ? {} : { state, ...(text ? { message: text } : {}) },
    })
  }
}

interface PaneWaitView {
  attention: PaneAttentionPeek
  exited: boolean
}

export function reachedState(
  view: PaneWaitView,
  until: readonly PaneWaitState[],
): PaneWaitState | undefined {
  const state = view.attention.state
  const agent: PaneWaitState | undefined =
    state === 'done' || state === 'waiting' || state === 'error'
      ? state
      : state === undefined
        ? 'idle'
        : undefined
  if (agent && until.includes(agent)) return agent
  if (view.exited && until.includes('exited')) return 'exited'
  return undefined
}

export function waitUntil(raw: unknown): readonly PaneWaitState[] {
  if (raw === undefined) return PANE_WAIT_DEFAULT_UNTIL
  if (!Array.isArray(raw) || raw.length === 0) throw fail('bad-request: until')
  for (const state of raw) {
    if (!(PANE_WAIT_STATES as readonly unknown[]).includes(state)) {
      throw fail(`bad-request: until ${String(state)} (known: ${PANE_WAIT_STATES.join(', ')})`)
    }
  }
  return raw as PaneWaitState[]
}

export function waitTimeout(raw: unknown): number {
  if (raw === undefined) return PANE_WAIT_DEFAULT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw fail('bad-request: timeoutMs')
  return Math.min(PANE_WAIT_MAX_MS, Math.max(PANE_WAIT_MIN_MS, raw))
}

export function commandFinished(
  base: TerminalProgress | undefined,
  now: TerminalProgress | undefined,
): boolean {
  if (!base || !now || now.running) return false
  return base.running || now.blockCount > base.blockCount
}

interface TerminalProgress {
  running: boolean
  blockCount: number
  lastExitCode?: number
}

type PaneWaitResult =
  | {
      reached: true
      paneId: string
      state: PaneWaitState
      message?: string
      exitCode?: number
      status?: PaneStatus
    }
  | { timedOut: true }
  | { closed: true; paneId: string }

export interface PaneWaitDeps extends PaneReachDeps {
  watch: PaneWatch
  attention: (pane: PaneIdentity) => Promise<PaneAttentionPeek>
  exited: (paneId: string) => boolean
  terminal: (paneId: string) => TerminalProgress | undefined
  status: (to: PaneIdentity, callerExternalId: string) => Promise<PaneStatus | undefined>
}

export function registerPaneWaitMethods(deps: PaneWaitDeps): void {
  registerControlMethod('pane.wait', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      if (!Array.isArray(p.panes) || p.panes.length === 0) throw fail('bad-request: panes')
      if (p.panes.length > PANE_WAIT_MAX_PANES) throw fail('too-many: panes')
      const until = waitUntil(p.until)
      const timeoutMs = waitTimeout(p.timeoutMs)
      const panes: { ref: string; to: PaneIdentity }[] = []
      for (const ref of p.panes as unknown[]) {
        panes.push({ ref: String(ref), to: await paneTarget(deps, ref, ctx) })
      }
      for (const { ref, to } of panes) {
        await ensurePaneReach(deps, 'read', to, ctx, {
          ref,
          method: 'pane.wait',
          detail: `wait on the agent state of ${to.externalId}`,
        })
      }

      const result = await new Promise<PaneWaitResult>((resolve) => {
        const known = new Map<string, PaneAttentionPeek>()
        const baseline = new Map(panes.map(({ to }) => [to.paneId, deps.terminal(to.paneId)]))
        const unwatch: (() => void)[] = []
        let settled = false
        const finish = (result: PaneWaitResult): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          for (const off of unwatch) off()
          closed.dispose()
          resolve(result)
        }
        const check = (to: PaneIdentity): void => {
          const attention = known.get(to.paneId)
          if (!attention) return
          const state = reachedState({ attention, exited: deps.exited(to.paneId) }, until)
          if (!state) return
          const message = state === 'exited' ? undefined : attention.message
          finish({ reached: true, paneId: to.externalId, state, ...(message ? { message } : {}) })
        }
        const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
        const closed = ctx.conn.onClose(() => finish({ timedOut: true }))
        for (const { to } of panes) {
          unwatch.push(
            deps.watch.watch(to.paneId, (change) => {
              if (change.kind === 'closed') finish({ closed: true, paneId: to.externalId })
              else if (change.kind === 'attention') known.set(to.paneId, change.attention)
              if (change.kind === 'closed') return
              const progress = deps.terminal(to.paneId)
              if (until.includes('command') && commandFinished(baseline.get(to.paneId), progress)) {
                finish({
                  reached: true,
                  paneId: to.externalId,
                  state: 'command',
                  ...(progress?.lastExitCode === undefined
                    ? {}
                    : { exitCode: progress.lastExitCode }),
                })
                return
              }
              check(to)
            }),
          )
        }
        for (const { to } of panes) {
          void deps.attention(to).then(
            (attention) => {
              if (!known.has(to.paneId)) known.set(to.paneId, attention)
              check(to)
            },
            () => undefined,
          )
        }
      })
      if (!('reached' in result)) return result
      const reachedPane = panes.find(({ to }) => to.externalId === result.paneId)?.to
      const status = reachedPane
        ? await deps.status(reachedPane, ctx.identity.externalId)
        : undefined
      return status ? { ...result, status } : result
    },
  })
}
