import { STALE_MAIL_MS, WAKE_BUDGET_MS } from '../../shared/agents/agentIssues'
import { STATUS_MESSAGE_MAX } from '../../shared/agents/closingLine'
import {
  ageLabel,
  type PaneStateName,
  type PaneStatus,
  type PaneStatusChanges,
} from '../../shared/panes/paneStatus'
import { mailCounts } from '../agents/busStore'
import { type ControlMethodContext, registerControlMethod } from '../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { PaneJournal, StampedEvent } from './paneJournal'
import type { PaneEntry } from './paneList'
import {
  ensurePaneReach,
  fail,
  holdsPaneReach,
  PANE_REFS_MAX,
  type PaneReachDeps,
  paneRefs,
  paneTarget,
  record,
} from './paneReach'

export interface GitFacts {
  branch: string | null
  ahead: number
  behind: number
  changed: number
}

export interface PaneStatusDeps extends PaneReachDeps {
  panes: () => Promise<PaneEntry[]>
  journal: PaneJournal
  exited: (paneId: string) => boolean
  git: (paneId: string, cwd: string | undefined) => Promise<GitFacts | undefined>
  wakingSince: (paneId: string) => number | undefined
  conflicts: (externalId: string) => string[]
  now: () => number
}

const AGENT_STATES: ReadonlySet<string> = new Set(['working', 'waiting', 'done', 'error'])

export function paneStateOf(entry: PaneEntry | undefined, exited: boolean): PaneStateName {
  if (!entry) return 'exited'
  if (entry.hibernated) return 'hibernated'
  if (entry.waking) return 'waking'
  if (entry.agentState && AGENT_STATES.has(entry.agentState))
    return entry.agentState as PaneStateName
  if (exited) return 'exited'
  if (entry.agent) return 'idle'
  return entry.running ? 'working' : 'shell'
}

export function summarizeChanges(
  first: boolean,
  events: readonly StampedEvent[],
): PaneStatusChanges {
  const states: string[] = []
  let commands = 0
  let failed = 0
  let closing = false
  let mail = 0
  for (const event of events) {
    if (event.kind === 'state') {
      if (states.length === 0 && event.from) states.push(event.from)
      states.push(event.state)
    } else if (event.kind === 'command') {
      commands += 1
      if (event.exitCode !== undefined && event.exitCode !== 0) failed += 1
    } else if (event.kind === 'closing') closing = true
    else mail += 1
  }
  return { first, states, commands, failed, closing, mail }
}

export function staleMarks(facts: {
  oldestQueuedMs?: number
  lastFailure?: string
  wakingMs?: number
}): string[] {
  return [
    facts.oldestQueuedMs !== undefined && facts.oldestQueuedMs > STALE_MAIL_MS
      ? `mail queued ${ageLabel(facts.oldestQueuedMs)}`
      : '',
    facts.wakingMs !== undefined && facts.wakingMs > WAKE_BUDGET_MS
      ? `waking ${ageLabel(facts.wakingMs)}`
      : '',
    facts.lastFailure ? `mail failed:${facts.lastFailure}` : '',
  ].filter(Boolean)
}

export function statusOf(
  entry: PaneEntry,
  facts: {
    exited: boolean
    closing?: string
    sinceMs?: number
    git?: GitFacts
    changes: PaneStatusChanges
    mail: PaneStatus['mail']
    stale?: string[]
    conflict?: string[]
  },
): PaneStatus {
  const state = paneStateOf(entry, facts.exited)
  const idle = !entry.running && entry.lastExitCode !== undefined && state !== 'working'
  return {
    pane: entry.paneId,
    title: entry.title || entry.paneId.slice(0, 8),
    state,
    ...(facts.sinceMs === undefined ? {} : { sinceMs: facts.sinceMs }),
    ...(facts.closing ? { closing: facts.closing.slice(0, STATUS_MESSAGE_MAX) } : {}),
    ...(idle ? { exitCode: entry.lastExitCode } : {}),
    ...(entry.process ? { process: { id: entry.process.id, status: entry.process.status } } : {}),
    ...(facts.git ? { git: facts.git } : {}),
    mail: facts.mail,
    stale: facts.stale ?? [],
    conflict: facts.conflict ?? [],
    changes: facts.changes,
  }
}

function mailFacts(
  externalId: string,
  wakingAt: number | undefined,
  now: number,
): { mail: PaneStatus['mail']; stale: string[] } {
  const { oldestQueuedMs, lastFailure, ...mail } = mailCounts(externalId)
  return {
    mail,
    stale: staleMarks({
      oldestQueuedMs,
      lastFailure,
      wakingMs: wakingAt === undefined ? undefined : now - wakingAt,
    }),
  }
}

export async function collectStatus(
  deps: Pick<PaneStatusDeps, 'journal' | 'exited' | 'git' | 'wakingSince' | 'conflicts' | 'now'>,
  to: PaneIdentity,
  callerExternalId: string,
  entries: readonly PaneEntry[],
): Promise<PaneStatus | undefined> {
  const entry = entries.find((item) => item.paneId === to.externalId)
  if (!entry) return undefined
  const now = deps.now()
  const seen = deps.journal.changes(callerExternalId, to.paneId)
  const stateAt = deps.journal.stateSince(to.paneId)
  return statusOf(entry, {
    exited: deps.exited(to.paneId),
    closing: deps.journal.closing(to.paneId),
    sinceMs: stateAt === undefined ? undefined : now - stateAt,
    git: await deps.git(to.paneId, entry.cwd),
    changes: summarizeChanges(seen.first, seen.first ? [] : seen.events),
    conflict: deps
      .conflicts(to.externalId)
      .map((id) => entries.find((item) => item.paneId === id)?.title || id.slice(0, 8)),
    ...mailFacts(to.externalId, deps.wakingSince(to.paneId), now),
  })
}

async function workspacePanes(
  deps: PaneStatusDeps,
  ctx: ControlMethodContext,
): Promise<{ ref: string; to: PaneIdentity }[]> {
  const me = ctx.identity
  if (me.kind !== 'pane') throw fail('bad-request: panes')
  const found: { ref: string; to: PaneIdentity }[] = []
  for (const entry of await deps.panes()) {
    const to = resolveExternal(entry.paneId)
    if (to?.kind !== 'pane' || to.workspaceId !== me.workspaceId || to === me) continue
    if (entry.kind === 'terminal' && (await holdsPaneReach(deps, 'read', to, ctx))) {
      found.push({ ref: entry.paneId, to })
    }
  }
  return found.slice(0, PANE_REFS_MAX)
}

export function registerPaneStatusMethods(deps: PaneStatusDeps): void {
  registerControlMethod('pane.status', {
    scripts: true,
    handler: async (raw, ctx) => {
      const given = record(raw).panes
      const targets: { ref: string; to: PaneIdentity }[] =
        given === undefined ? await workspacePanes(deps, ctx) : []
      if (given !== undefined) {
        for (const ref of paneRefs(given)) {
          targets.push({ ref, to: await paneTarget(deps, ref, ctx) })
        }
      }
      for (const { ref, to } of targets) {
        await ensurePaneReach(deps, 'read', to, ctx, {
          ref,
          method: 'pane.status',
          detail: `status of ${to.externalId}`,
        })
      }
      const entries = await deps.panes()
      const panes: PaneStatus[] = []
      for (const { to } of targets) {
        const status = await collectStatus(deps, to, ctx.identity.externalId, entries)
        if (status) panes.push(status)
      }
      return { panes }
    },
  })
}
