import { VIEWER_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/viewerSelection'
import { JSDOM } from 'jsdom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { currentSelection, sourceLinesOf, trackSelection } from './selection'

const SOURCE_HTML =
  '<article><h1 data-line-start="1" data-line-end="1">Title</h1>' +
  '<p data-line-start="3" data-line-end="4">First line second line</p>' +
  '<ul data-line-start="6" data-line-end="6"><li data-line-start="6" data-line-end="6">item</li></ul></article>'

let window: JSDOM['window']
let article: HTMLElement

function select(from: Node, start: number, to: Node, end: number): void {
  const range = window.document.createRange()
  range.setStart(from, start)
  range.setEnd(to, end)
  const selection = window.document.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

beforeEach(() => {
  vi.useFakeTimers()
  const dom = new JSDOM(`<body>${SOURCE_HTML}<button>outside</button></body>`)
  window = dom.window
  window.Range.prototype.getBoundingClientRect = () =>
    ({ x: 10, y: 20, width: 30, height: 12 }) as DOMRect
  article = window.document.querySelector('article') as HTMLElement
})

afterEach(() => {
  vi.useRealTimers()
})

describe('sourceLinesOf', () => {
  it('maps a range to the first and last source line it touches', () => {
    const heading = article.querySelector('h1')?.firstChild as Node
    const item = article.querySelector('li')?.firstChild as Node
    select(heading, 2, item, 4)
    const range = window.document.getSelection()?.getRangeAt(0) as Range
    expect(sourceLinesOf(range, article)).toEqual({ startLine: 1, endLine: 6 })
  })

  it('returns null for a range outside any tagged block', () => {
    const outside = window.document.querySelector('button')?.firstChild as Node
    select(outside, 0, outside, 3)
    const range = window.document.getSelection()?.getRangeAt(0) as Range
    expect(sourceLinesOf(range, article)).toBeNull()
  })
})

describe('currentSelection', () => {
  it('reports the text, source lines and box of a selection in the article', () => {
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, 10)
    expect(currentSelection(article)).toEqual({
      text: 'First line',
      shortened: false,
      startLine: 3,
      endLine: 4,
      rect: { x: 10, y: 20, width: 30, height: 12 },
    })
  })

  it('reports nothing for a collapsed selection or one outside the article', () => {
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 2, paragraph, 2)
    expect(currentSelection(article)).toBeNull()
    const outside = window.document.querySelector('button')?.firstChild as Node
    select(outside, 0, outside, 3)
    expect(currentSelection(article)).toBeNull()
  })
})

describe('a selection over the text cap', () => {
  it('is cut to the cap and says so', () => {
    const long = 'x'.repeat(VIEWER_TEXT_MAX + 10)
    ;(article.querySelector('p') as HTMLElement).textContent = long
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, long.length)
    const picked = currentSelection(article)
    expect(picked?.shortened).toBe(true)
    expect(picked?.text.length).toBe(VIEWER_TEXT_MAX)
  })

  it('never ends on half of a surrogate pair', () => {
    const long = `${'x'.repeat(VIEWER_TEXT_MAX - 1)}😀tail`
    ;(article.querySelector('p') as HTMLElement).textContent = long
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, long.length)
    expect(currentSelection(article)?.text.length).toBe(VIEWER_TEXT_MAX - 1)
  })
})

describe('trackSelection', () => {
  function track() {
    const sink = { publish: vi.fn(), clear: vi.fn() }
    const tracker = trackSelection(article, sink)
    return { sink, tracker }
  }

  it('publishes when the pointer is released over a selection, and not twice for the same one', () => {
    const { sink } = track()
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, 5)
    window.document.dispatchEvent(new window.Event('pointerup'))
    vi.advanceTimersByTime(1)
    expect(sink.publish).toHaveBeenCalledTimes(1)
    expect(sink.publish.mock.calls[0][0]).toMatchObject({ text: 'First', startLine: 3 })
    window.document.dispatchEvent(new window.Event('keyup'))
    vi.advanceTimersByTime(1)
    expect(sink.publish).toHaveBeenCalledTimes(1)
  })

  it('clears on a press elsewhere and on Escape, collapsing the selection for Escape', () => {
    const { sink, tracker } = track()
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, 5)
    tracker.sync()
    window.document.dispatchEvent(new window.Event('pointerdown'))
    expect(sink.clear).toHaveBeenCalledTimes(1)
    tracker.sync()
    window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }))
    expect(sink.clear).toHaveBeenCalledTimes(2)
    expect(window.document.getSelection()?.rangeCount).toBe(0)
  })

  it('publishes again where the selection moved after the page scrolls, and clears when it is gone', () => {
    const { sink, tracker } = track()
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, 5)
    tracker.sync()
    window.Range.prototype.getBoundingClientRect = () =>
      ({ x: 10, y: -40, width: 30, height: 12 }) as DOMRect
    window.dispatchEvent(new window.Event('scroll'))
    vi.advanceTimersByTime(200)
    expect(sink.publish).toHaveBeenCalledTimes(2)
    window.document.getSelection()?.removeAllRanges()
    window.dispatchEvent(new window.Event('scroll'))
    vi.advanceTimersByTime(200)
    expect(sink.clear).toHaveBeenCalledTimes(1)
  })

  it('stops listening and clears when destroyed', () => {
    const { sink, tracker } = track()
    const paragraph = article.querySelector('p')?.firstChild as Node
    select(paragraph, 0, paragraph, 5)
    tracker.sync()
    tracker.destroy()
    expect(sink.clear).toHaveBeenCalledTimes(1)
    window.document.dispatchEvent(new window.Event('pointerup'))
    vi.advanceTimersByTime(1)
    expect(sink.publish).toHaveBeenCalledTimes(1)
  })
})
