import { describe, expect, it } from 'vitest'
import { GPU_CONTEXT_BUDGET, GpuBudget, leastRecentlyShown } from './gpuBudget'

interface Fake {
  name: string
  holds: boolean
  acquired: number
  revoked: number
}

function members(budget: GpuBudget, names: string[], acquires = () => true) {
  return names.map((name) => {
    const fake: Fake = { name, holds: false, acquired: 0, revoked: 0 }
    const slot = budget.join({
      acquire: () => {
        fake.acquired++
        fake.holds = acquires()
        return fake.holds
      },
      revoke: () => {
        fake.revoked++
        fake.holds = false
      },
    })
    return { fake, slot }
  })
}

function holding(list: { fake: Fake }[]): string[] {
  return list.filter((m) => m.fake.holds).map((m) => m.fake.name)
}

describe('leastRecentlyShown', () => {
  it('picks the hidden holder shown longest ago and never a shown one', () => {
    const holders = [
      { id: 'a', shown: true, shownAt: 1 },
      { id: 'b', shown: false, shownAt: 4 },
      { id: 'c', shown: false, shownAt: 2 },
      { id: 'd', shown: false, shownAt: 3 },
    ]
    expect(leastRecentlyShown(holders)?.id).toBe('c')
  })

  it('finds nothing when every holder is on screen', () => {
    expect(leastRecentlyShown([{ shown: true, shownAt: 1 }])).toBeNull()
    expect(leastRecentlyShown([])).toBeNull()
  })
})

describe('GpuBudget', () => {
  it('stays below the sixteen contexts Chromium keeps', () => {
    expect(GPU_CONTEXT_BUDGET).toBeLessThan(16)
  })

  it('keeps a hidden holder until the budget is full, then revokes the least recently shown', () => {
    const budget = new GpuBudget(2)
    const [a, b, c] = members(budget, ['a', 'b', 'c'])
    a.slot.show()
    b.slot.show()
    a.slot.hide()
    b.slot.hide()
    a.slot.show()
    a.slot.hide()
    expect(holding([a, b, c])).toEqual(['a', 'b'])
    expect(a.fake.acquired).toBe(1)

    c.slot.show()
    expect(holding([a, b, c])).toEqual(['a', 'c'])
    expect(b.fake.revoked).toBe(1)
  })

  it('makes a shown pane wait while all slots are on screen and serves the newest waiter first', () => {
    const budget = new GpuBudget(1)
    const [a, b, c] = members(budget, ['a', 'b', 'c'])
    a.slot.show()
    b.slot.show()
    c.slot.show()
    expect(holding([a, b, c])).toEqual(['a'])

    a.slot.hide()
    expect(holding([a, b, c])).toEqual(['c'])
    expect(a.fake.revoked).toBe(1)
  })

  it('drops a waiter that is hidden before a slot frees', () => {
    const budget = new GpuBudget(1)
    const [a, b] = members(budget, ['a', 'b'])
    a.slot.show()
    b.slot.show()
    b.slot.hide()
    a.slot.dispose()
    expect(b.fake.acquired).toBe(0)
  })

  it('hands a disposed holder slot to a waiter without revoking it', () => {
    const budget = new GpuBudget(1)
    const [a, b] = members(budget, ['a', 'b'])
    a.slot.show()
    b.slot.show()
    a.slot.dispose()
    expect(a.fake.revoked).toBe(0)
    expect(holding([b])).toEqual(['b'])
  })

  it('asks again for a shown pane whose context was lost and frees the slot of a hidden one', () => {
    const budget = new GpuBudget(1)
    const [a, b] = members(budget, ['a', 'b'])
    a.slot.show()
    a.slot.lost()
    expect(a.fake.acquired).toBe(2)

    a.slot.hide()
    b.slot.show()
    expect(b.fake.acquired).toBe(1)
    b.slot.hide()
    b.slot.lost()
    a.slot.show()
    expect(b.fake.revoked).toBe(0)
    expect(a.fake.acquired).toBe(3)
  })

  it('does not count a pane whose context could not be made', () => {
    const budget = new GpuBudget(1)
    const [a] = members(budget, ['a'], () => false)
    const [b] = members(budget, ['b'])
    a.slot.show()
    b.slot.show()
    expect(holding([a, b])).toEqual(['b'])
    expect(b.fake.acquired).toBe(1)
  })

  it('ignores calls from a disposed slot', () => {
    const budget = new GpuBudget(1)
    const [a, b] = members(budget, ['a', 'b'])
    a.slot.dispose()
    a.slot.show()
    b.slot.show()
    expect(a.fake.acquired).toBe(0)
    expect(holding([b])).toEqual(['b'])
  })
})
