import { describe, expect, it } from 'vitest'
import { newRecordId } from './hookEvent'
import { INJECT_CHARS_MAX, injectionOf } from './rememberInject'
import type { RememberItem } from './rememberItem'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 14, 12)

function item(text: string, t = NOW): RememberItem {
  return {
    v: 1,
    id: newRecordId(),
    t,
    pane: 'p1',
    session: 's1',
    agent: 'claude',
    text,
    state: 'open',
  }
}

describe('remembered tasks given back to an agent', () => {
  it('says nothing when there is nothing to give', () => {
    expect(injectionOf([], NOW)).toEqual({ text: '', count: 0 })
  })

  it('gives a header and one line per task with its age', () => {
    const a = item('Bisect fixture order', NOW - 2 * DAY)
    const b = item('Confirm the retry cap')
    const { text, count } = injectionOf([b, a], NOW)
    expect(count).toBe(2)
    const lines = text.split('\n')
    expect(lines[0]).toContain('ostia activity remember')
    expect(lines[1]).toBe(`- [${b.id}] Confirm the retry cap (today)`)
    expect(lines[2]).toBe(`- [${a.id}] Bisect fixture order (2 d ago)`)
  })

  it('gives at most ten tasks and says how many are left', () => {
    const items = Array.from({ length: 13 }, (_, i) => item(`task ${i}`))
    const { text, count } = injectionOf(items, NOW)
    expect(count).toBe(10)
    expect(text.split('\n').at(-1)).toBe('+3 more: ostia activity list --remembered')
  })

  it('stays within the character cap and keeps whole lines', () => {
    const items = Array.from({ length: 10 }, (_, i) => item(`${i} ${'x'.repeat(190)}`))
    const { text, count } = injectionOf(items, NOW)
    expect(text.length).toBeLessThanOrEqual(INJECT_CHARS_MAX)
    expect(count).toBeLessThan(10)
    expect(text.split('\n').at(-1)).toMatch(/^\+\d+ more:/)
    for (const line of text.split('\n').slice(1, -1)) expect(line.startsWith('- [')).toBe(true)
  })
})
