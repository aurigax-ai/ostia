import type { AgentBusyReason } from '../../shared/agents/agentWork'
import { STATUS_MESSAGE_MAX } from '../../shared/agents/closingLine'
import { backgroundWork, type ProcessRow } from '../agents/agentWork'
import { getByPaneId, type PaneIdentity, resolveExternal } from '../control/idRegistry'
import type { PaneEntry } from './paneList'

const MINUTE_MS = 60_000

export interface PaneLifecycleDeps {
  rows: () => Promise<ProcessRow[] | null>
  reported: (paneId: string) => AgentBusyReason | null
  drafting: (paneId: string) => boolean
  ownerOf: (paneId: string) => string | undefined
  nameOf: (paneId: string) => string | undefined
  closing: (paneId: string) => string | undefined
  post: (from: string, to: string, text: string) => void
  hibernate: (to: PaneIdentity) => Promise<unknown>
  hibernateMinutes: () => number
  now: () => number
}

export interface PaneLifecycleFacts {
  owner?: string
  finished: boolean
  finishedSince?: number
}

export function finishedOf(
  entry: PaneEntry,
  busy: AgentBusyReason | null,
  drafting: boolean,
): boolean {
  if (entry.kind !== 'terminal' || !entry.agent || entry.agentState !== 'done') return false
  if (entry.waking) return false
  if (entry.hibernated) return true
  return busy === null && !drafting
}

export class PaneLifecycle {
  private readonly since = new Map<string, number>()

  constructor(private readonly deps: PaneLifecycleDeps) {}

  async evaluate(entries: readonly PaneEntry[]): Promise<Map<string, PaneLifecycleFacts>> {
    const rows = await this.deps.rows()
    const facts = new Map<string, PaneLifecycleFacts>()
    const live = new Set<string>()
    for (const entry of entries) {
      const identity = resolveExternal(entry.paneId)
      if (identity?.kind !== 'pane') continue
      live.add(entry.paneId)
      const busy = entry.pid
        ? backgroundWork(this.deps.reported(identity.paneId), rows, entry.pid)
        : 'unknown'
      const finished = finishedOf(entry, busy, this.deps.drafting(identity.paneId))
      const owner = this.deps.ownerOf(identity.paneId)
      const since = this.settle(entry.paneId, identity, finished, owner)
      facts.set(entry.paneId, {
        finished,
        ...(since === undefined ? {} : { finishedSince: since }),
        ...(owner ? { owner } : {}),
      })
    }
    for (const id of this.since.keys()) if (!live.has(id)) this.since.delete(id)
    return facts
  }

  async annotate(entries: PaneEntry[], ownedBy?: string): Promise<PaneEntry[]> {
    const facts = await this.evaluate(entries)
    const wanted =
      ownedBy === undefined
        ? entries
        : entries.filter((e) => facts.get(e.paneId)?.owner === ownedBy)
    return wanted.map((entry) => {
      const found = facts.get(entry.paneId)
      if (!found) return entry
      const owner = found.owner ? this.ownerLabel(found.owner) : undefined
      return {
        ...entry,
        finished: found.finished,
        ...(found.finishedSince === undefined ? {} : { finishedSince: found.finishedSince }),
        ...(owner ? { owner } : {}),
      }
    })
  }

  async hibernateDue(entries: readonly PaneEntry[]): Promise<string[]> {
    const minutes = this.deps.hibernateMinutes()
    const facts = await this.evaluate(entries)
    if (minutes <= 0) return []
    const hibernated: string[] = []
    for (const entry of entries) {
      const found = facts.get(entry.paneId)
      const since = found?.finishedSince
      if (!found?.owner || since === undefined || entry.hibernated || entry.keepAwake) continue
      if (this.deps.now() - since < minutes * MINUTE_MS) continue
      const identity = resolveExternal(entry.paneId)
      if (identity?.kind !== 'pane') continue
      await this.deps.hibernate(identity).catch(() => undefined)
      hibernated.push(entry.paneId)
    }
    return hibernated
  }

  private ownerLabel(ownerInternal: string): string {
    return (
      this.deps.nameOf(ownerInternal) ?? getByPaneId(ownerInternal)?.externalId ?? ownerInternal
    )
  }

  private settle(
    externalId: string,
    identity: PaneIdentity,
    finished: boolean,
    owner: string | undefined,
  ): number | undefined {
    const known = this.since.get(externalId)
    if (!finished) {
      this.since.delete(externalId)
      return undefined
    }
    if (known !== undefined) return known
    const at = this.deps.now()
    this.since.set(externalId, at)
    if (owner) this.announce(identity, owner)
    return at
  }

  private announce(child: PaneIdentity, owner: string): void {
    const ownerIdentity = getByPaneId(owner)
    if (!ownerIdentity) return
    const closing = this.deps.closing(child.paneId)
    const name = this.deps.nameOf(child.paneId) ?? child.externalId
    const line = closing
      ? `${name} finished: ${closing.slice(0, STATUS_MESSAGE_MAX)}`
      : `${name} finished`
    this.deps.post(child.externalId, ownerIdentity.externalId, line)
  }
}
