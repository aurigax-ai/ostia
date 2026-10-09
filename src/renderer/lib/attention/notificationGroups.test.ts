import type { NotificationEntry } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { groupNotifications, inTab } from './notificationGroups'

const entry = (
  id: string,
  kind: NotificationEntry['kind'],
  paneId?: string,
): NotificationEntry => ({
  id,
  ts: '2026-09-30T10:00:00Z',
  kind,
  title: id,
  from: 'x',
  ...(paneId ? { paneId } : {}),
})

describe('notification tabs', () => {
  it('puts waiting, approvals and errors under Needs you', () => {
    expect(inTab(entry('a', 'waiting'), 'needs')).toBe(true)
    expect(inTab(entry('b', 'approval'), 'needs')).toBe(true)
    expect(inTab(entry('c', 'error'), 'needs')).toBe(true)
    expect(inTab(entry('d', 'done'), 'needs')).toBe(false)
    expect(inTab(entry('d', 'done'), 'done')).toBe(true)
    expect(inTab(entry('e', 'message'), 'messages')).toBe(true)
    expect(inTab(entry('e', 'message'), 'all')).toBe(true)
  })
})

describe('groupNotifications', () => {
  it('groups by workspace in the order of each group’s newest entry', () => {
    const where: Record<string, string> = { p1: 'home', p2: 'model-runtime' }
    const groups = groupNotifications(
      [entry('n3', 'done', 'p2'), entry('n2', 'waiting', 'p1'), entry('n1', 'done', 'p2')],
      (e) => ({ key: where[e.paneId ?? ''] ?? 'closed', label: where[e.paneId ?? ''] ?? 'Closed' }),
    )
    expect(groups.map((g) => [g.label, g.entries.map((e) => e.id)])).toEqual([
      ['model-runtime', ['n3', 'n1']],
      ['home', ['n2']],
    ])
  })
})
