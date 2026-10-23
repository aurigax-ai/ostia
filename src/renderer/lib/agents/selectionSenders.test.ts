import { describe, expect, it, vi } from 'vitest'
import { openSelectionSend, registerSelectionSender } from './selectionSenders'

describe('selection senders', () => {
  it('answers with the newest sender of a pane and falls back to the one under it', () => {
    const editor = vi.fn()
    const preview = vi.fn()
    const dropEditor = registerSelectionSender('p1', editor)
    const dropPreview = registerSelectionSender('p1', preview)
    expect(openSelectionSend('p1')).toBe(true)
    expect(preview).toHaveBeenCalledTimes(1)
    expect(editor).not.toHaveBeenCalled()
    dropPreview()
    expect(openSelectionSend('p1')).toBe(true)
    expect(editor).toHaveBeenCalledTimes(1)
    dropEditor()
    expect(openSelectionSend('p1')).toBe(false)
  })

  it('keeps the sender above when one below goes first', () => {
    const editor = vi.fn()
    const preview = vi.fn()
    const dropEditor = registerSelectionSender('p2', editor)
    const dropPreview = registerSelectionSender('p2', preview)
    dropEditor()
    openSelectionSend('p2')
    expect(preview).toHaveBeenCalledTimes(1)
    dropPreview()
    expect(openSelectionSend('p2')).toBe(false)
  })
})
