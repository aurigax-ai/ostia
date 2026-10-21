import { describe, expect, it, vi } from 'vitest'
import { phoneInputNoter } from './phoneInput'

describe('phoneInputNoter', () => {
  it('notes only the first input after a wait was set, per pane', () => {
    const since = new Map<string, number>([
      ['p1', 100],
      ['p2', 200],
    ])
    const sent = vi.fn()
    const note = phoneInputNoter((id) => since.get(id), sent)
    note('p1')
    note('p1')
    note('p1')
    expect(sent.mock.calls).toEqual([['p1']])
    note('p2')
    expect(sent.mock.calls).toEqual([['p1'], ['p2']])
  })

  it('notes again for a later wait of the same pane', () => {
    const since = new Map<string, number>([['p1', 100]])
    const sent = vi.fn()
    const note = phoneInputNoter((id) => since.get(id), sent)
    note('p1')
    since.delete('p1')
    note('p1')
    since.set('p1', 300)
    note('p1')
    note('p1')
    expect(sent).toHaveBeenCalledTimes(2)
  })

  it('notes nothing for a pane that is not waiting', () => {
    const sent = vi.fn()
    phoneInputNoter(() => undefined, sent)('p1')
    expect(sent).not.toHaveBeenCalled()
  })
})
