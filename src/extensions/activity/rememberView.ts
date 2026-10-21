import { type RememberItem, type RememberState, startOf } from './rememberItem'
import type { OpenPane, PaneLabel } from './view'

const DAY_MS = 86_400_000
const STALE_FROM = 0.5
const EXPIRING_FROM = 0.9

export type Fade = 'fresh' | 'stale' | 'old'

export function fadeOf(start: number, now: number, days: number): Fade {
  const share = (now - start) / (days * DAY_MS)
  if (share >= EXPIRING_FROM) return 'old'
  return share >= STALE_FROM ? 'stale' : 'fresh'
}

export function daysLeft(start: number, now: number, days: number): number {
  return Math.max(0, Math.ceil((start + days * DAY_MS - now) / DAY_MS))
}

type RememberWhere = 'open' | 'parked' | 'closed'

export interface RememberRow {
  id: string
  start: number
  text: string
}

export interface RememberGroup {
  key: string
  paneId: string
  label: PaneLabel
  where: RememberWhere
  rows: RememberRow[]
}

export interface RememberView {
  days: number
  counts: Record<RememberState, number>
  groups: Record<RememberState, RememberGroup[]>
}

function labelOf(item: RememberItem, pane: OpenPane | undefined): PaneLabel {
  const title = pane?.title?.trim()
  const agent = item.agent === 'claude' || item.agent === 'codex' ? item.agent : undefined
  return { ...(agent ? { agent } : {}), ...(title ? { title } : {}), n: 1 }
}

function groupsOf(
  items: readonly RememberItem[],
  panes: ReadonlyMap<string, OpenPane>,
  parked: ReadonlySet<string>,
): RememberGroup[] {
  const bySession = new Map<string, RememberItem[]>()
  for (const item of items) {
    const known = bySession.get(item.session)
    if (known) known.push(item)
    else bySession.set(item.session, [item])
  }
  const groups: RememberGroup[] = []
  for (const [session, list] of bySession) {
    const rows = [...list].sort((a, b) => startOf(b) - startOf(a))
    const newest = rows[0]
    if (!newest) continue
    const pane = panes.get(newest.pane)
    groups.push({
      key: session,
      paneId: newest.pane,
      label: labelOf(newest, pane),
      where: pane ? 'open' : parked.has(session) ? 'parked' : 'closed',
      rows: rows.map((item) => ({ id: item.id, start: startOf(item), text: item.text })),
    })
  }
  return groups.sort((a, b) => (b.rows[0]?.start ?? 0) - (a.rows[0]?.start ?? 0))
}

export function rememberView(
  items: readonly RememberItem[],
  panes: readonly OpenPane[],
  parked: ReadonlySet<string>,
  days: number,
): RememberView {
  const byId = new Map(panes.map((pane) => [pane.paneId, pane]))
  const of = (state: RememberState) => items.filter((item) => item.state === state)
  return {
    days,
    counts: { open: of('open').length, done: of('done').length, archived: of('archived').length },
    groups: {
      open: groupsOf(of('open'), byId, parked),
      done: groupsOf(of('done'), byId, parked),
      archived: groupsOf(of('archived'), byId, parked),
    },
  }
}
