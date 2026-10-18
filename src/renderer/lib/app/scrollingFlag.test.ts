import '@testing-library/jest-dom/vitest'
import {
  SCROLLING_ATTRIBUTE,
  SCROLL_IDLE_MS,
  watchScrolling,
} from '@aurigax-ai/ostia-extension-sdk/contract/scrollbar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('watchScrolling', () => {
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    stop = watchScrolling(document)
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
  })

  const scroller = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

  it('marks the element that scrolls and clears it after the idle time', () => {
    scroller('a').dispatchEvent(new Event('scroll'))
    expect(scroller('a')).toHaveAttribute(SCROLLING_ATTRIBUTE)
    expect(scroller('b')).not.toHaveAttribute(SCROLLING_ATTRIBUTE)
    vi.advanceTimersByTime(SCROLL_IDLE_MS)
    expect(scroller('a')).not.toHaveAttribute(SCROLLING_ATTRIBUTE)
  })

  it('keeps the mark while scrolling continues and restarts the idle time', () => {
    scroller('a').dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 1)
    scroller('a').dispatchEvent(new Event('scroll'))
    vi.advanceTimersByTime(SCROLL_IDLE_MS - 1)
    expect(scroller('a')).toHaveAttribute(SCROLLING_ATTRIBUTE)
    vi.advanceTimersByTime(1)
    expect(scroller('a')).not.toHaveAttribute(SCROLLING_ATTRIBUTE)
  })

  it('marks the root element when the page itself scrolls', () => {
    document.dispatchEvent(new Event('scroll'))
    expect(document.documentElement).toHaveAttribute(SCROLLING_ATTRIBUTE)
  })

  it('stops watching and clears every mark', () => {
    scroller('a').dispatchEvent(new Event('scroll'))
    stop()
    expect(scroller('a')).not.toHaveAttribute(SCROLLING_ATTRIBUTE)
    scroller('b').dispatchEvent(new Event('scroll'))
    expect(scroller('b')).not.toHaveAttribute(SCROLLING_ATTRIBUTE)
  })
})
