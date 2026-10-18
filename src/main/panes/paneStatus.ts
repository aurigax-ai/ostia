import { STATUS_MESSAGE_MAX } from '../../shared/agents/closingLine'
import type { PaneStateName, PaneStatus, PaneStatusChanges } from '../../shared/panes/paneStatus'
import { mailCounts } from '../agents/busStore'
import { registerControlMethod } from '../control/controlServer'
import type { PaneJournal, StampedEvent } from './paneJournal'
import type { PaneEntry } from './paneList'
import { type PaneReachDeps, ensurePaneReach, paneRefs, paneTarget, record } from './paneReach'

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

export function statusOf(
  entry: PaneEntry,
  facts: {
    exited: boolean
    closing?: string
    sinceMs?: number
    git?: GitFacts
    changes: PaneStatusChanges
    mail: PaneStatus['mail']
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
    changes: facts.changes,
  }
}

export function registerPaneStatusMethods(deps: PaneStatusDeps): void {
  registerControlMethod('pane.status', {
    scripts: true,
    handler: async (raw, ctx) => {
      const refs = paneRefs(record(raw).panes)
      const targets = []
      for (const ref of refs) targets.push({ ref, to: await paneTarget(deps, ref, ctx) })
      for (const { ref, to } of targets) {
        await ensurePaneReach(deps, 'read', to, ctx, {
          ref,
          method: 'pane.status',
          detail: `status of ${to.externalId}`,
        })
      }
      const entries = await deps.panes()
      const now = deps.now()
      const panes: PaneStatus[] = []
      for (const { to } of targets) {
        const entry = entries.find((item) => item.paneId === to.externalId)
        if (!entry) continue
        const seen = deps.journal.changes(ctx.identity.externalId, to.paneId)
        const stateAt = deps.journal.stateSince(to.paneId)
        panes.push(
          statusOf(entry, {
            exited: deps.exited(to.paneId),
            closing: deps.journal.closing(to.paneId),
            sinceMs: stateAt === undefined ? undefined : now - stateAt,
            git: await deps.git(to.paneId, entry.cwd),
            changes: summarizeChanges(seen.first, seen.first ? [] : seen.events),
            mail: mailCounts(to.externalId),
          }),
        )
      }
      return { panes }
    },
  })
}
