import { describe, expect, it } from 'vitest'
import { newRecordId } from './hookEvent'
import type { RememberItem } from './rememberItem'
import { daysLeft, fadeOf, rememberView } from './rememberView'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 14, 12)

function item(extra: Partial<RememberItem> = {}): RememberItem {
  return {
    v: 1,
    id: newRecordId(),
    t: NOW,
    pane: 'p1',
    session: 's1',
    agent: 'claude',
    text: 'task',
    state: 'open',
    ...extra,
  }
}

describe('remembered tasks in the panel', () => {
  it('fades by the share of the lifetime used', () => {
    expect(fadeOf(NOW - 6 * DAY, NOW, 14)).toBe('fresh')
    expect(fadeOf(NOW - 7 * DAY, NOW, 14)).toBe('stale')
    expect(fadeOf(NOW - 12.6 * DAY, NOW, 14)).toBe('old')
    expect(daysLeft(NOW - 12 * DAY, NOW, 14)).toBe(2)
    expect(daysLeft(NOW - 20 * DAY, NOW, 14)).toBe(0)
  })

  it('groups by session, newest session first, with the newest task first inside', () => {
    const view = rememberView(
      [
        item({ session: 's1', t: NOW - 3 * DAY, text: 'older' }),
        item({ session: 's1', t: NOW - DAY, text: 'newer' }),
        item({ session: 's2', pane: 'p2', agent: 'codex', t: NOW - 5 * DAY, text: 'other' }),
      ],
      [],
      new Set(),
      14,
    )
    expect(view.groups.open.map((g) => g.key)).toEqual(['s1', 's2'])
    expect(view.groups.open[0]?.rows.map((r) => r.text)).toEqual(['newer', 'older'])
    expect(view.counts).toEqual({ open: 3, done: 0, archived: 0 })
  })

  it('splits states and says where each session is: open pane, parked or closed', () => {
    const view = rememberView(
      [
        item({ session: 's1', pane: 'p1' }),
        item({ session: 's2', pane: 'gone' }),
        item({ session: 's3', pane: 'gone2' }),
        item({ state: 'done', doneAt: NOW }),
        item({ state: 'archived', archivedAt: NOW }),
      ],
      [{ paneId: 'p1', title: 'export-tests' }],
      new Set(['s2']),
      14,
    )
    const where = Object.fromEntries(view.groups.open.map((g) => [g.key, g.where]))
    expect(where).toEqual({ s1: 'open', s2: 'parked', s3: 'closed' })
    expect(view.groups.open.find((g) => g.key === 's1')?.label).toMatchObject({
      agent: 'claude',
      title: 'export-tests',
    })
    expect(view.counts).toEqual({ open: 3, done: 1, archived: 1 })
    expect(view.groups.done).toHaveLength(1)
    expect(view.groups.archived).toHaveLength(1)
  })

  it('counts a restored task from its restore time', () => {
    const view = rememberView(
      [item({ t: NOW - 30 * DAY, restoredAt: NOW - DAY })],
      [],
      new Set(),
      14,
    )
    expect(view.groups.open[0]?.rows[0]?.start).toBe(NOW - DAY)
  })
})
