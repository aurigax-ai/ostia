import type { QuestionRequest } from '@shared/agents/questions'
import type { ApprovalRequest } from '@shared/permissions/approvals'
import { describe, expect, it } from 'vitest'
import type { NeedsYouItem, PaneWhere } from '@/lib/sidebar/dashboard'
import { cardPane, inboxCards, waitingCount } from './panelInbox'

const question = (id: string, paneId: string, at: number): QuestionRequest => ({
  id,
  paneId,
  question: id,
  context: '',
  choices: [],
  mode: 'text',
  at,
})

const approval = (id: string, workspaceId: string, at: number): ApprovalRequest => ({
  id,
  paneId: 'pa',
  workspaceId,
  caps: [],
  action: id,
  detail: '',
  at,
})

const where = (workspaceId: string): PaneWhere => ({
  workspaceId,
  workspace: workspaceId,
  path: '/p',
  shortPath: '/p',
  pane: 'tab',
})

const whereOf = (item: NeedsYouItem): PaneWhere | null =>
  item.kind === 'question'
    ? item.question.paneId.startsWith('mine')
      ? where('w1')
      : where('w2')
    : null

describe('inbox cards', () => {
  it('lists the workspace’s questions, approvals and notes in one flat list, oldest first', () => {
    const cards = inboxCards({
      questions: [question('late', 'mine-1', 30), question('other', 'theirs', 5)],
      sent: [],
      approvals: [approval('mid', 'w1', 20), approval('elsewhere', 'w2', 1)],
      sync: [],
      notes: [{ id: 'abcdefghij', text: 'note', paneId: 'p1', at: 10 }],
      workspaceId: 'w1',
      whereOf,
    })
    expect(cards.map((c) => c.id)).toEqual(['abcdefghij', 'mid', 'late'])
    expect(cards.map((c) => c.kind)).toEqual(['note', 'item', 'item'])
  })

  it('names the pane a card belongs to, and none for a note without one', () => {
    const cards = inboxCards({
      questions: [question('q', 'mine-1', 1)],
      sent: [],
      approvals: [approval('a', 'w1', 2)],
      sync: [],
      notes: [
        { id: 'abcdefghij', text: 'n', at: 3 },
        { id: 'bcdefghijk', text: 'm', paneId: 'p9', at: 4 },
      ],
      workspaceId: 'w1',
      whereOf,
    })
    expect(cards.map(cardPane)).toEqual(['mine-1', 'pa', undefined, 'p9'])
  })

  it('keeps a question just answered in the list but does not count it as waiting', () => {
    const answered = question('done', 'mine-1', 1)
    const cards = inboxCards({
      questions: [question('open', 'mine-1', 2)],
      sent: [answered],
      approvals: [approval('a', 'w1', 3)],
      sync: [],
      notes: [{ id: 'abcdefghij', text: 'n', at: 4 }],
      workspaceId: 'w1',
      whereOf,
    })
    expect(cards).toHaveLength(4)
    expect(waitingCount(cards)).toBe(3)
  })

  it('SYA-C130 shows a sync card in every workspace, counts it as waiting and has no pane', () => {
    const sync = [
      {
        item: {
          kind: 'join' as const,
          id: 'join:d2',
          deviceId: 'd2',
          name: 'Phone',
          code: 'AAAAA-BBBBB',
          createdAt: 5,
        },
        at: 5,
      },
    ]
    for (const workspaceId of ['w1', 'w2']) {
      const cards = inboxCards({
        questions: [],
        sent: [],
        approvals: [],
        sync,
        notes: [],
        workspaceId,
        whereOf,
      })
      expect(cards.map((c) => c.kind)).toEqual(['sync'])
      expect(cardPane(cards[0])).toBeUndefined()
      expect(waitingCount(cards)).toBe(1)
    }
  })
})
