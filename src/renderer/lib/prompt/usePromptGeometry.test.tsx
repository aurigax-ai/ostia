import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { usePromptGeometry } from './usePromptGeometry'

function terminalHost(): HTMLDivElement {
  const stack = document.createElement('div')
  const host = document.createElement('div')
  host.innerHTML = '<div class="xterm-screen"></div>'
  stack.append(host)
  document.body.append(stack)
  const screen = host.querySelector('.xterm-screen') as HTMLElement
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 8 * 80, height: 17 * 24 }) as DOMRect
  return host
}

function fakeTerminal(): { term: Xterm; listening: () => number } {
  let listeners = 0
  const on = () => () => {
    listeners++
    return { dispose: () => listeners-- }
  }
  const line = { getCell: () => ({ getChars: () => '' }) }
  const term = {
    rows: 24,
    cols: 80,
    buffer: {
      active: {
        type: 'normal',
        viewportY: 0,
        baseY: 0,
        cursorY: 3,
        cursorX: 2,
        getLine: () => line,
      },
    },
    onRender: on(),
    onScroll: on(),
    onResize: on(),
  } as unknown as Xterm
  return { term, listening: () => listeners }
}

describe('usePromptGeometry', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  it('does not follow a hidden pane and keeps its last geometry until shown again', () => {
    const { term, listening } = fakeTerminal()
    const refs = { termRef: { current: term }, hostRef: { current: terminalHost() } }
    const { result, rerender } = renderHook(
      ({ shown }) => usePromptGeometry(refs.termRef, refs.hostRef, true, shown, 'shell', false),
      { initialProps: { shown: false } },
    )
    expect(listening()).toBe(0)
    expect(result.current).toBeNull()

    rerender({ shown: true })
    expect(listening()).toBe(3)
    const shownGeometry = result.current
    expect(shownGeometry?.placement.row).toBe(3)

    rerender({ shown: false })
    expect(listening()).toBe(0)
    expect(result.current).toBe(shownGeometry)
  })
})
