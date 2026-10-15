import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLinkHint } from './linkHint'

describe('createLinkHint', () => {
  let visible: boolean
  let published: (string | null)[]

  beforeEach(() => {
    vi.useFakeTimers()
    visible = true
    published = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const hintAfter400 = () =>
    createLinkHint<string>(
      400,
      () => visible,
      (hint) => published.push(hint),
    )

  it('shows the hint once the pointer has stayed on the link for the delay', () => {
    const hint = hintAfter400()
    hint.show(() => 'box')
    vi.advanceTimersByTime(399)
    expect(published).toEqual([])
    vi.advanceTimersByTime(1)
    expect(published).toEqual(['box'])
  })

  it('never shows a hint whose timer was pending when it was hidden', () => {
    const hint = hintAfter400()
    hint.show(() => 'box')
    vi.advanceTimersByTime(200)
    hint.hide()
    vi.advanceTimersByTime(1_000)
    expect(published).toEqual([null])
  })

  it('never shows a hint whose pane stopped being visible while its timer was pending', () => {
    const hint = hintAfter400()
    const measure = vi.fn(() => 'box')
    hint.show(measure)
    visible = false
    vi.advanceTimersByTime(1_000)
    expect(measure).not.toHaveBeenCalled()
    expect(published).toEqual([])
  })

  it('shows only the link hovered last', () => {
    const hint = hintAfter400()
    hint.show(() => 'first')
    vi.advanceTimersByTime(300)
    hint.show(() => 'second')
    vi.advanceTimersByTime(400)
    expect(published).toEqual(['second'])
  })

  it('shows nothing when the link cannot be measured', () => {
    const hint = hintAfter400()
    hint.show(() => null)
    vi.advanceTimersByTime(400)
    expect(published).toEqual([])
  })
})
