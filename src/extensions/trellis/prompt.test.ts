import { describe, expect, it } from 'vitest'
import {
  PROMPT_BODY_MAX,
  reviewColumn,
  sessionContext,
  taskLabel,
  taskLine,
  taskPrompt,
} from './prompt'
import { translate } from './testFake'
import type { CardDetail } from './trellis'

const t = translate('en')

function controls(text: string, allowed = ''): string[] {
  return [...text].filter((ch) => (ch < ' ' || ch === '\x7f') && !allowed.includes(ch))
}

function card(over: Partial<CardDetail> = {}): CardDetail {
  return {
    ref: 'SHOP-7',
    title: 'Fix the cart',
    column: 'backlog',
    priority: 'normal',
    labels: [],
    version: 1,
    updatedAt: 0,
    createdAt: 0,
    relations: [],
    body: 'Steps:\n\n1. Empty the cart\n2. Pay',
    ...over,
  }
}

describe('reviewColumn', () => {
  it('picks the first review column whose name needs no quoting', () => {
    expect(reviewColumn(['backlog', 'in-progress', 'review', 'done'])).toBe('review')
    expect(reviewColumn(['todo', 'In Review', 'code-review'])).toBe('code-review')
    expect(reviewColumn(['todo', 'done'])).toBeNull()
  })
})

describe('taskPrompt', () => {
  it('names the card, keeps its body and points at the skill, with the commands as a fallback', () => {
    const prompt = taskPrompt(card(), 'review', t)
    expect(prompt.split('\n\n')[0]).toBe('Work on Trellis card SHOP-7: Fix the cart')
    expect(prompt).toContain('Steps:\n\n1. Empty the cart\n2. Pay')
    expect(prompt.split('\n\n').at(-1)).toBe(
      'Follow the trellis-card skill to work on it. Without that skill: read the card with `trellis card show SHOP-7`, claim it with `trellis card claim SHOP-7`, comment your progress with `trellis card comment SHOP-7 --body "…"`, and when you are done move it to review with `trellis card move SHOP-7 review`.',
    )
  })

  it('says the same in Traditional Chinese, with the skill id and commands unchanged', () => {
    const prompt = taskPrompt(card(), 'review', translate('zh-Hant'))
    for (const kept of [
      'trellis-card',
      '`trellis card show SHOP-7`',
      '`trellis card claim SHOP-7`',
      '`trellis card comment SHOP-7 --body "…"`',
      '`trellis card move SHOP-7 review`',
    ]) {
      expect(prompt, kept).toContain(kept)
    }
    expect(prompt).not.toContain('Follow the')
  })

  it('drops control characters, leaves out an empty body and names no column it does not know', () => {
    const prompt = taskPrompt(card({ title: 'Fix\x1b[31m it\x07', body: '  ' }), null, t)
    expect(controls(prompt, '\n')).toEqual([])
    expect(prompt.split('\n\n')).toHaveLength(2)
    expect(prompt).toContain('move it to the column where it waits for review.')
  })

  it('cuts a long body and says where to read the rest', () => {
    const prompt = taskPrompt(card({ body: 'x'.repeat(PROMPT_BODY_MAX + 500) }), null, t)
    expect(prompt).toContain('x'.repeat(PROMPT_BODY_MAX))
    expect(prompt).not.toContain('x'.repeat(PROMPT_BODY_MAX + 1))
    expect(prompt).toContain('read all of it with `trellis card show`')
  })
})

describe('taskLine', () => {
  it('is one line without the body, so pasting it can never submit', () => {
    const line = taskLine(card({ title: 'Fix\nthe\r\ncart' }), 'review', t)
    expect(controls(line)).toEqual([])
    expect(line).not.toContain('Empty the cart')
    expect(line).toBe(
      'Work on Trellis card SHOP-7 (Fix the cart) with the trellis-card skill. Without that skill: read it with `trellis card show SHOP-7`, claim it with `trellis card claim SHOP-7`, comment your progress with `trellis card comment SHOP-7 --body …`, and when you are done move it to review with `trellis card move SHOP-7 review`.',
    )
  })

  it('names no column it does not know', () => {
    expect(taskLine(card(), null, t)).toMatch(
      /and when you are done move it to the column where it waits for review\.$/,
    )
  })
})

describe('sessionContext', () => {
  it('names the project and its board in one line, and the skill to use', () => {
    expect(sessionContext({ project: 'SHOP', board: 'web', marker: '/p/.trellis' })).toBe(
      'This folder belongs to Trellis project SHOP, board web. The trellis-card skill explains how to work on one of its cards.',
    )
    expect(sessionContext({ project: 'SHOP', marker: '/p/.trellis' })).toBe(
      'This folder belongs to Trellis project SHOP. The trellis-card skill explains how to work on one of its cards.',
    )
  })

  it('adds nothing for a folder without a project', () => {
    expect(sessionContext(null)).toBe('')
  })
})

describe('taskLabel', () => {
  it('joins ref and title and stays within the offer label limit', () => {
    expect(taskLabel(card())).toBe('SHOP-7 · Fix the cart')
    expect(taskLabel(card({ title: 'y'.repeat(300) }))).toHaveLength(120)
  })
})
