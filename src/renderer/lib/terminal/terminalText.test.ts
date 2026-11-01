import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OstiaTerminal } from './ostiaTerminal'
import { attachTerminalText } from './terminalText'

function emitter<T = void>() {
  const listeners = new Set<(arg: T) => void>()
  return {
    event: (listener: (arg: T) => void) => {
      listeners.add(listener)
      return { dispose: () => listeners.delete(listener) }
    },
    fire: (arg: T) => {
      for (const listener of [...listeners]) listener(arg)
    },
  }
}

function fakeTerminal(lines: string[], rows: number, viewportY = 0) {
  const state = { lines, rows, viewportY }
  const render = emitter<{ start: number; end: number }>()
  const scroll = emitter<number>()
  const resize = emitter<{ cols: number; rows: number }>()
  const change = emitter<unknown>()
  const term = {
    get rows() {
      return state.rows
    },
    buffer: {
      get active() {
        return {
          viewportY: state.viewportY,
          getLine: (y: number) =>
            state.lines[y] === undefined ? undefined : { translateToString: () => state.lines[y] },
        }
      },
      onBufferChange: change.event,
    },
    onRender: render.event,
    onWriteParsed: emitter().event,
    onScroll: scroll.event,
    onResize: resize.event,
  } as unknown as OstiaTerminal
  return { term, state, render, scroll, resize }
}

describe('terminal text layer', () => {
  let parent: HTMLElement
  let now = 0

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'],
    })
    now = 0
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    parent = document.createElement('div')
    document.body.append(parent)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    parent.remove()
  })

  const tick = (ms: number): void => {
    now += ms
    vi.advanceTimersByTime(ms)
  }

  it('is a labelled log region that is clipped, not hidden', () => {
    const fake = fakeTerminal(['a'], 1)
    const text = attachTerminalText(
      parent,
      { term: fake.term, displayed: () => fake.term, onDisplay: () => () => {} },
      'Terminal output',
      () => true,
    )
    expect(text.region.getAttribute('role')).toBe('log')
    expect(text.region.getAttribute('aria-live')).toBe('off')
    expect(text.region.getAttribute('aria-label')).toBe('Terminal output')
    expect(text.region.hidden).toBe(false)
    expect(text.region.getAttribute('aria-hidden')).toBeNull()
    text.dispose()
    expect(parent.querySelector('.terminal-text')).toBeNull()
  })

  it('shows the rows of the viewport and changes only the rows that changed', () => {
    const fake = fakeTerminal(['old 0', 'old 1', 'one', 'two', 'three'], 3, 2)
    const text = attachTerminalText(
      parent,
      { term: fake.term, displayed: () => fake.term, onDisplay: () => () => {} },
      'Terminal output',
      () => true,
    )
    tick(20)
    const rows = [...text.region.children]
    expect(rows.map((row) => row.textContent)).toEqual(['one', 'two', 'three'])
    fake.state.lines = ['old 0', 'old 1', 'one', 'TWO', 'three']
    fake.render.fire({ start: 0, end: 2 })
    tick(60)
    const after = [...text.region.children]
    expect(after.map((row) => row.textContent)).toEqual(['one', 'TWO', 'three'])
    expect(after[0]).toBe(rows[0])
    expect(after[2]).toBe(rows[2])
    text.dispose()
  })

  it('commits at most once per interval while output streams', async () => {
    const fake = fakeTerminal(['x'], 1)
    const text = attachTerminalText(
      parent,
      { term: fake.term, displayed: () => fake.term, onDisplay: () => () => {} },
      'Terminal output',
      () => true,
    )
    tick(20)
    const node = text.region.children[0]
    let writeCount = 0
    new MutationObserver(() => {
      writeCount++
    }).observe(node, { childList: true, characterData: true, subtree: true })
    for (let i = 0; i < 20; i++) {
      fake.state.lines = [`line ${i}`]
      fake.render.fire({ start: 0, end: 0 })
      tick(1)
    }
    tick(100)
    await Promise.resolve()
    expect(writeCount).toBeLessThanOrEqual(2)
    expect(text.region.textContent).toBe('line 19')
    text.dispose()
  })

  it('follows resizes and reads the displayed terminal, not the live one', () => {
    const live = fakeTerminal(['live'], 1)
    const layer = fakeTerminal(['earlier 0', 'earlier 1'], 2)
    let showing = live.term
    let notify = () => {}
    const text = attachTerminalText(
      parent,
      {
        term: live.term,
        displayed: () => showing,
        onDisplay: (listener) => {
          notify = listener
          return () => {}
        },
      },
      'Terminal output',
      () => true,
    )
    tick(20)
    expect(text.region.textContent).toBe('live')
    showing = layer.term
    notify()
    tick(60)
    expect([...text.region.children].map((row) => row.textContent)).toEqual([
      'earlier 0',
      'earlier 1',
    ])
    text.dispose()
  })

  it('does not write while the pane is hidden and catches up when it is shown', () => {
    const fake = fakeTerminal(['first'], 1)
    let visible = false
    const text = attachTerminalText(
      parent,
      { term: fake.term, displayed: () => fake.term, onDisplay: () => () => {} },
      'Terminal output',
      () => visible,
    )
    tick(100)
    expect(text.region.textContent).toBe('')
    fake.state.lines = ['second']
    fake.render.fire({ start: 0, end: 0 })
    tick(100)
    expect(text.region.textContent).toBe('')
    visible = true
    text.setShown(true)
    tick(20)
    expect(text.region.textContent).toBe('second')
    text.dispose()
  })

  it('Escape in the region hands focus back to the terminal input', () => {
    const fake = fakeTerminal(['a'], 1)
    const host = document.createElement('div')
    host.className = 'ghostty-host'
    const input = document.createElement('textarea')
    host.append(input)
    parent.append(host)
    const text = attachTerminalText(
      parent,
      { term: fake.term, displayed: () => fake.term, onDisplay: () => () => {} },
      'Terminal output',
      () => true,
    )
    text.review()
    expect(document.activeElement).toBe(text.region)
    text.region.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(document.activeElement).toBe(input)
    text.dispose()
  })
})
