import { createPane } from '@/layout/tree'
import type { QuestionRequest } from '@shared/agents/questions'
import type { ApprovalRequest } from '@shared/permissions/approvals'
import { describe, expect, it } from 'vitest'
import { CONTEXT_FOLD_CHARS, agoText, isLongContext, needsYouItems, paneWhere } from './dashboard'

function question(id: string, at: number): QuestionRequest {
  return { id, paneId: 'p1', question: id, context: '', choices: [], mode: 'text', at }
}

function approval(id: string, at: number): ApprovalRequest {
  return { id, paneId: 'p1', workspaceId: 'w1', caps: ['shell'], action: 'a', detail: '', at }
}

describe('needsYouItems', () => {
  it('lists questions and approvals together, oldest first', () => {
    const items = needsYouItems(
      [question('q-new', 30), question('q-old', 10)],
      [],
      [approval('a-mid', 20)],
    )
    expect(items.map((i) => i.id)).toEqual(['q-old', 'a-mid', 'q-new'])
  })

  it('keeps an answered question in place as sent until it is dropped', () => {
    const items = needsYouItems([question('q2', 20)], [question('q1', 10)], [])
    expect(items.map((i) => [i.id, i.kind === 'question' && i.sent])).toEqual([
      ['q1', true],
      ['q2', false],
    ])
  })

  it('shows a question once when it is both open and marked sent', () => {
    const q = question('q1', 10)
    expect(needsYouItems([q], [q], [])).toHaveLength(1)
  })
})

describe('isLongContext', () => {
  it('folds a context with many lines or many characters', () => {
    expect(isLongContext('short')).toBe(false)
    expect(isLongContext('a\nb\nc\nd')).toBe(false)
    expect(isLongContext('a\nb\nc\nd\ne')).toBe(true)
    expect(isLongContext('x'.repeat(CONTEXT_FOLD_CHARS + 1))).toBe(true)
  })
})

describe('agoText', () => {
  const format = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'short' })

  it('says just now under a minute, then minutes, hours and days', () => {
    expect(agoText(59_000, 'just now', format)).toBe('just now')
    expect(agoText(3 * 60_000, 'just now', format)).toBe('3 min. ago')
    expect(agoText(2 * 3_600_000 + 5, 'just now', format)).toBe('2 hr. ago')
    expect(agoText(49 * 3_600_000, 'just now', format)).toBe('2 days ago')
  })
})

describe('paneWhere', () => {
  const pane = { ...createPane('terminal'), title: 'claude' }
  const workspaces = [
    { id: 'w1', name: 'api', workDir: '~/work/api' },
    {
      id: 'w2',
      name: 'web',
      customName: 'Storefront',
      workDir: '/home/u/a/very/long/path/to/some/deeply/nested/project/web',
      projectDir: '/home/u/a/very/long/path/to/some/deeply/nested/project/web',
    },
  ]

  it('names the workspace, its folder and the pane that holds the pane id', () => {
    expect(paneWhere(pane.id, workspaces, { w1: { root: pane } })).toEqual({
      workspaceId: 'w1',
      workspace: 'api',
      path: '~/work/api',
      shortPath: '~/work/api',
      pane: 'claude',
    })
  })

  it('prefers the custom name and shortens a long folder from the middle', () => {
    const where = paneWhere(pane.id, workspaces, { w2: { root: pane } })
    expect(where?.workspace).toBe('Storefront')
    expect(where?.path).toBe('/home/u/a/very/long/path/to/some/deeply/nested/project/web')
    expect(where?.shortPath).toBe('/…/path/to/some/deeply/nested/project/web')
  })

  it('answers null for a pane no workspace holds', () => {
    expect(paneWhere('gone', workspaces, { w1: { root: pane } })).toBeNull()
  })
})
