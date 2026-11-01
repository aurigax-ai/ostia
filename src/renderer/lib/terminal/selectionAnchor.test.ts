import { describe, expect, it } from 'vitest'
import type { OstiaTerminal } from './ostiaTerminal'
import { terminalSelectionAnchor } from './selectionAnchor'

function rectOf(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  }
}

function terminalWith(
  range: unknown,
  viewportY: number,
): { term: OstiaTerminal; container: HTMLElement } {
  const container = document.createElement('div')
  container.getBoundingClientRect = () => rectOf(10, 20, 0, 0)
  const host = document.createElement('div')
  const screen = document.createElement('div')
  screen.className = 'ghostty-screen'
  screen.getBoundingClientRect = () => rectOf(30, 40, 800, 480)
  host.append(screen)
  const term = {
    cols: 80,
    rows: 24,
    element: host,
    buffer: { active: { viewportY } },
    getSelectionPosition: () => range,
  } as unknown as OstiaTerminal
  return { term, container }
}

describe('terminalSelectionAnchor', () => {
  it('places the bar at the selected cells, measured in the container', () => {
    const { term, container } = terminalWith({ start: { x: 5, y: 13 }, end: { x: 9, y: 14 } }, 10)
    expect(terminalSelectionAnchor(term, container)).toEqual({ left: 60, top: 60, bottom: 100 })
  })

  it('clamps a selection that runs past the viewport and has no anchor without one', () => {
    const { term, container } = terminalWith({ start: { x: 1, y: 2 }, end: { x: 4, y: 100 } }, 10)
    expect(terminalSelectionAnchor(term, container)).toEqual({
      left: 20,
      top: 20,
      bottom: 480 + 20,
    })
    const none = terminalWith(undefined, 0)
    expect(terminalSelectionAnchor(none.term, none.container)).toBeNull()
  })
})
