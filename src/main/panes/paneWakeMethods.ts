import type { ResponseError } from 'vscode-jsonrpc/node'
import {
  actThenConfirm,
  anyOf,
  ChangeSignal,
  confirmed,
  mismatch,
} from '../../shared/common/actThenConfirm'
import type { CommandResult } from '../../shared/control/commands'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import type { PaneIdentity } from '../control/idRegistry'
import { liveSessionHolder, type PaneEntry } from './paneList'
import { ensurePaneReach, fail, type PaneReachDeps, paneRefs, record } from './paneReach'
import type { PaneWaking } from './paneWaking'

const WAKE_WAIT_MIN_MS = 1000
const WAKE_WAIT_DEFAULT_MS = WAKE_BUDGET_MS
const WAKE_WAIT_MAX_MS = 30 * 60_000

function wakeWaitTimeout(raw: unknown): number {
  if (raw === undefined) return WAKE_WAIT_DEFAULT_MS
  if (typeof raw !== 'number' || !Number.isFinite(raw)) throw fail('bad-request: timeoutMs')
  return Math.min(WAKE_WAIT_MAX_MS, Math.max(WAKE_WAIT_MIN_MS, raw))
}

import { WAKE_BUDGET_MS } from '../../shared/agents/agentIssues'
import type { AgentJournal } from '../diagnostics/agentJournal'

export interface PaneWakeDeps extends PaneReachDeps {
  hibernated: (pane: PaneIdentity) => Promise<boolean>
  wake: (pane: PaneIdentity) => Promise<{ woke: boolean; conflict?: string }>
  hibernate: (pane: PaneIdentity) => Promise<CommandResult>
  keptAwake: (pane: PaneIdentity) => Promise<boolean>
  panes: () => Promise<PaneEntry[]>
  waking: PaneWaking
  resume: (pane: PaneIdentity) => Promise<CommandResult>
  journal?: Pick<AgentJournal, 'wakeNotReady'>
}

type WakeAnswer =
  | { ok: true; woke: string[]; started: true }
  | { ok: true; woke: string[]; timedOut: true }
  | { ok: true; woke: string[]; closed: string }

function agentIsLive(entry: PaneEntry | undefined): boolean {
  return Boolean(entry?.agent) && entry?.running === true
}

export function notHibernated(to: PaneIdentity): ResponseError<void> {
  return fail(`not-hibernated: ${to.externalId} is not hibernated`)
}

function keptAwake(to: PaneIdentity): ResponseError<void> {
  return fail(
    `keep-awake: ${to.externalId} is kept awake and only its human can hibernate it; ask its agent to run ostia pane keep-awake --off`,
  )
}

function notResumable(to: PaneIdentity): ResponseError<void> {
  return fail(
    `not-resumable: ${to.externalId} has no agent session to resume, or is not at its prompt`,
  )
}

export function sessionConflict(to: PaneIdentity, other: string): ResponseError<void> {
  return fail(
    `session-conflict: the agent session of ${to.externalId} is already running in ${other}; close one of them`,
  )
}

export function checkSessions(targets: PaneIdentity[], panes: PaneEntry[]): void {
  const taken = new Map<string, string>()
  for (const to of targets) {
    const holder = liveSessionHolder(panes, to.externalId)
    if (holder) throw sessionConflict(to, `${holder.paneId} ("${holder.title}")`)
    const id = panes.find((p) => p.paneId === to.externalId)?.agentSessionId
    if (!id) continue
    const earlier = taken.get(id)
    if (earlier) throw sessionConflict(to, earlier)
    taken.set(id, to.externalId)
  }
}

export function registerPaneWakeMethods(
  deps: PaneWakeDeps & {
    target: (
      raw: unknown,
      ctx: ControlMethodContext,
      destructive?: boolean,
    ) => Promise<PaneIdentity>
    ensureManagerInput: (ctx: ControlMethodContext) => void
  },
): void {
  const { target, ensureManagerInput } = deps

  registerControlMethod('pane.wake', {
    scripts: true,
    handler: async (raw, ctx) => {
      const p = record(raw)
      const refs = paneRefs(p.panes)
      const timeoutMs = wakeWaitTimeout(p.timeoutMs)
      ensureManagerInput(ctx)
      const waited: PaneIdentity[] = []
      const asleepPanes: PaneIdentity[] = []
      const awakePanes: PaneIdentity[] = []
      const already: string[] = []
      const listed = await deps.panes()
      for (const ref of refs) {
        const to = await target(ref, ctx, true)
        await ensurePaneReach(deps, 'input', to, ctx, {
          ref,
          method: 'pane.wake',
          detail: `wake ${to.externalId}: type its agent's resume command`,
        })
        if (deps.waking.has(to.paneId)) {
          waited.push(to)
        } else if (await deps.hibernated(to)) {
          asleepPanes.push(to)
          waited.push(to)
        } else if (agentIsLive(listed.find((entry) => entry.paneId === to.externalId))) {
          already.push(to.externalId)
        } else {
          awakePanes.push(to)
        }
      }
      checkSessions([...asleepPanes, ...awakePanes], listed)
      const answer = <T extends object>(value: T) =>
        already.length > 0 ? { ...value, already } : value
      const woke: string[] = []
      const marked: PaneIdentity[] = []
      try {
        for (const to of asleepPanes) {
          marked.push(to)
          deps.waking.start(to.paneId)
          const outcome = await deps.wake(to)
          if (outcome.conflict) throw sessionConflict(to, `"${outcome.conflict}"`)
          if (!outcome.woke) throw notResumable(to)
          woke.push(to.externalId)
        }
        for (const to of awakePanes) {
          marked.push(to)
          deps.waking.start(to.paneId)
          const res = await deps.resume(to)
          if (!res.ok) throw fail(res.error.message)
          if ((res.result as { resumed?: unknown } | undefined)?.resumed !== true) {
            throw notResumable(to)
          }
          waited.push(to)
          woke.push(to.externalId)
        }
      } catch (err) {
        for (const to of marked) deps.waking.abandon(to.paneId)
        throw err
      }
      if (waited.length === 0) return answer({ ok: true, woke })
      const began = Date.now()
      const cancelled = new ChangeSignal()
      const closedConn = ctx.conn.onClose(() => cancelled.fire())
      let gone = false
      cancelled.subscribe(() => {
        gone = true
      })
      const seen = await actThenConfirm<WakeAnswer>({
        act: () => undefined,
        observe: () => {
          if (gone) return mismatch('cancelled', { ok: true, woke, timedOut: true })
          for (const to of waited) {
            const end = deps.waking.lastEnd(to.paneId)
            if (end === 'closed')
              return mismatch('closed', { ok: true, woke, closed: to.externalId })
            if (end === 'failed') {
              const why = deps.waking.lastReason(to.paneId) ?? 'its agent did not start'
              return mismatch(`not-started: ${to.externalId} ${why}; read it with ostia pane read`)
            }
          }
          const started = waited.every((to) => deps.waking.lastEnd(to.paneId) === 'started')
          return started ? confirmed({ ok: true, woke, started: true }) : undefined
        },
        signal: anyOf(deps.waking.changes.subscribe, cancelled.subscribe),
        timeoutMs,
        onTimeout: () => mismatch('timed out', { ok: true, woke, timedOut: true }),
      })
      closedConn.dispose()
      const notReady = seen.value
        ? 'timedOut' in seen.value && seen.value.timedOut === true
        : !seen.ok && seen.reason.startsWith('not-started')
      if (notReady)
        deps.journal?.wakeNotReady(
          Date.now() - began,
          waited.map((woken) => woken.externalId),
        )
      if (seen.value) return answer(seen.value)
      throw fail(seen.ok ? 'not-started' : seen.reason)
    },
  })

  registerControlMethod('pane.hibernate', {
    scripts: true,
    handler: async (raw, ctx) => {
      const refs = paneRefs(record(raw).panes)
      const panes: PaneIdentity[] = []
      for (const ref of refs) {
        const to = await target(ref, ctx, true)
        await ensurePaneReach(deps, 'close', to, ctx, {
          ref,
          method: 'pane.hibernate',
          detail: `hibernate ${to.externalId}: stop its agent until it is woken`,
        })
        if (await deps.keptAwake(to)) throw keptAwake(to)
        panes.push(to)
      }
      const hibernated: string[] = []
      const already: string[] = []
      const skipped: Record<string, string> = {}
      for (const to of panes) {
        if (await deps.hibernated(to)) {
          already.push(to.externalId)
          continue
        }
        const res = await deps.hibernate(to)
        if (!res.ok) throw fail(res.error.message)
        const outcome = (res.result as { outcome?: unknown } | undefined)?.outcome
        if (outcome === 'hibernated') hibernated.push(to.externalId)
        else skipped[to.externalId] = typeof outcome === 'string' ? outcome : 'unknown'
      }
      return { ok: true, hibernated, ...(already.length > 0 ? { already } : {}), skipped }
    },
  })
}
