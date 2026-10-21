import '@testing-library/jest-dom/vitest'
import {
  SCROLL_IDLE_MS,
  SCROLLBAR_HOVER_ATTRIBUTE,
  SCROLLING_ATTRIBUTE,
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

  describe('pointer over the scrollbar', () => {
    function geometry(el: HTMLElement): void {
      for (const [name, value] of Object.entries({
        offsetWidth: 100,
        clientWidth: 89,
        offsetHeight: 100,
        clientHeight: 100,
      })) {
        Object.defineProperty(el, name, { configurable: true, value })
      }
    }

    function move(el: Element, offsetX: number): void {
      const event = new Event('pointermove', { bubbles: true })
      Object.defineProperty(event, 'offsetX', { value: offsetX })
      Object.defineProperty(event, 'offsetY', { value: 10 })
      el.dispatchEvent(event)
    }

    it('marks the scroller while the pointer is in its scrollbar gutter, not over its content', () => {
      geometry(scroller('a'))
      move(scroller('a'), 40)
      expect(scroller('a')).not.toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
      move(scroller('a'), 95)
      expect(scroller('a')).toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
      move(scroller('a'), 40)
      expect(scroller('a')).not.toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
    })

    it('moves the mark to another scroller and clears it when the pointer leaves the window', () => {
      geometry(scroller('a'))
      geometry(scroller('b'))
      move(scroller('a'), 95)
      move(scroller('b'), 95)
      expect(scroller('a')).not.toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
      expect(scroller('b')).toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
      scroller('b').dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: null }),
      )
      expect(scroller('b')).not.toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
    })

    it('ignores an element without a scrollbar', () => {
      move(scroller('a'), 95)
      expect(scroller('a')).not.toHaveAttribute(SCROLLBAR_HOVER_ATTRIBUTE)
    })
  })
})
