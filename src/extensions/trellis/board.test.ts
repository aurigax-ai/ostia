import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DONE_COLUMN_LIMIT,
  actorName,
  claimState,
  findCard,
  groupEntries,
  moveCard,
  shownColumns,
  threadItems,
} from './board'
import {
  type TrellisBoard,
  type TrellisCard,
  parseBoard,
  parseCardThread,
  parseVaultList,
} from './trellis'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../../test/fixtures/tools/trellis', name), 'utf8')

const board = (): TrellisBoard => {
  const parsed = parseBoard(fixture('board.json'))
  if (!parsed) throw new Error('no board')
  return parsed
}

const LIVE_AT = 1790892187647 - 1

describe('claimState', () => {
  const card = (claimedBy?: string, claimUntil?: number): TrellisCard => ({
    ref: 'A-1',
    title: '',
    column: 'backlog',
    priority: 'normal',
    labels: [],
    version: 1,
    updatedAt: 0,
    claimedBy,
    claimUntil,
  })

  it('tells the human own claims from others and from expired ones', () => {
    expect(claimState(card(), 'human:ostia', 10)).toBe('none')
    expect(claimState(card('human:ostia', 20), 'human:ostia', 10)).toBe('mine')
    expect(claimState(card('agent:x', 20), 'human:ostia', 10)).toBe('other')
    expect(claimState(card('agent:x', 10), 'human:ostia', 10)).toBe('none')
    expect(claimState(card('agent:x'), 'human:ostia', 10)).toBe('other')
  })
})

describe('actorName', () => {
  it('shortens long session ids and keeps short names', () => {
    expect(actorName('agent:5f3c9a1e7b2d4c6f8a0b1c2d3e4f5a6b')).toBe('agent 5f3c9a')
    expect(actorName('agent:trellis-panel')).toBe('agent trellis-panel')
    expect(actorName('cli:4242')).toBe('cli 4242')
    expect(actorName('someone')).toBe('someone')
  })
})

describe('shownColumns', () => {
  it('keeps every column and filters cards by ref, title, label and priority', () => {
    const refs = (query: string) =>
      shownColumns(board(), query).map((c) => c.cards.map((x) => x.ref))
    expect(refs('')).toEqual([['DEMO-5', 'DEMO-3'], ['DEMO-1'], ['DEMO-2'], ['DEMO-4']])
    expect(refs('runbook')).toEqual([['DEMO-3'], [], [], []])
    expect(refs('BUG high')).toEqual([[], ['DEMO-1'], [], []])
    expect(refs('demo-2')).toEqual([[], [], ['DEMO-2'], []])
    expect(shownColumns(board(), 'runbook').map((c) => c.total)).toEqual([2, 1, 1, 1])
  })

  it('shows only the newest cards of a done column and counts the rest', () => {
    const b = board()
    const done = b.columns[3]
    done.cards = Array.from({ length: DONE_COLUMN_LIMIT + 5 }, (_, i) => ({
      ...done.cards[0],
      ref: `DEMO-${100 + i}`,
      updatedAt: i,
    }))
    const shown = shownColumns(b, '')[3]
    expect(shown.cards).toHaveLength(DONE_COLUMN_LIMIT)
    expect(shown.cards[0].ref).toBe(`DEMO-${100 + DONE_COLUMN_LIMIT + 4}`)
    expect(shown.hidden).toBe(5)
    expect(shown.total).toBe(DONE_COLUMN_LIMIT + 5)
  })
})

describe('moveCard', () => {
  it('moves a card to the end of another column without touching the source board', () => {
    const before = board()
    const after = moveCard(before, 'DEMO-3', 'review')
    expect(after.columns[2].cards.map((c) => c.ref)).toEqual(['DEMO-2', 'DEMO-3'])
    expect(after.columns[0].cards.map((c) => c.ref)).toEqual(['DEMO-5'])
    expect(findCard(after, 'DEMO-3')?.column).toBe('review')
    expect(findCard(before, 'DEMO-3')?.column).toBe('backlog')
  })

  it('returns the same board for an unknown card, column or no change', () => {
    const b = board()
    expect(moveCard(b, 'DEMO-99', 'review')).toBe(b)
    expect(moveCard(b, 'DEMO-3', 'nowhere')).toBe(b)
    expect(moveCard(b, 'DEMO-3', 'backlog')).toBe(b)
  })
})

describe('threadItems', () => {
  it('orders comments and activity by time and leaves label events out', () => {
    const thread = parseCardThread(fixture('http-card-DEMO-1.json'))
    if (!thread) throw new Error('no thread')
    const items = threadItems(thread)
    expect(items.map((i) => (i.kind === 'comment' ? 'comment' : i.activity.action))).toEqual([
      'created',
      'claimed',
      'moved',
      'comment',
    ])
    expect(claimState(board().columns[1].cards[0], 'human:ostia', LIVE_AT)).toBe('other')
  })
})

describe('groupEntries', () => {
  it('groups entries by directory and filters by title, summary, tag and template', () => {
    const entries = parseVaultList(fixture('vault-ls.json')) ?? []
    expect(groupEntries(entries, '').map((g) => [g.dir, g.entries.map((e) => e.slug)])).toEqual([
      ['', ['database-concurrency']],
      ['ops/deploy', ['ops/deploy/rollback-a-deploy']],
    ])
    expect(groupEntries(entries, 'runbook').map((g) => g.dir)).toEqual(['ops/deploy'])
    expect(groupEntries(entries, 'WAL').map((g) => g.dir)).toEqual([''])
    expect(groupEntries(entries, 'nothing')).toEqual([])
  })
})
