import { describe, expect, it, vi } from 'vitest'
import type { PaneIdentity } from '../control/idRegistry'
import { phoneInputNoted } from './phoneInput'

const pane = { paneId: 'p1', externalId: 'x1' } as PaneIdentity

describe('phoneInputNoted', () => {
  it('writes the phone key and then notes input for the pane', () => {
    const order: string[] = []
    const write = vi.fn(() => void order.push('write'))
    const sent = vi.fn(() => void order.push('sent'))
    phoneInputNoted(write, () => pane, sent)('p1', 'y', 'key')
    expect(write).toHaveBeenCalledWith('p1', 'y', 'key')
    expect(sent).toHaveBeenCalledWith(pane)
    expect(order).toEqual(['write', 'sent'])
  })

  it('notes a phone paste', () => {
    const sent = vi.fn()
    phoneInputNoted(vi.fn(), () => pane, sent)('p1', 'text', 'paste')
    expect(sent).toHaveBeenCalledWith(pane)
  })

  it('notes writes without a source, like the interrupt key', () => {
    const sent = vi.fn()
    phoneInputNoted(vi.fn(), () => pane, sent)('p1', '\x1b')
    expect(sent).toHaveBeenCalledWith(pane)
  })

  it('writes and notes nothing for a pane main does not know', () => {
    const write = vi.fn()
    const sent = vi.fn()
    phoneInputNoted(write, () => undefined, sent)('gone', 'y', 'key')
    expect(write).toHaveBeenCalledWith('gone', 'y', 'key')
    expect(sent).not.toHaveBeenCalled()
  })
})
