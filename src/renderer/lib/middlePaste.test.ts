import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installMiddlePasteGuard } from './middlePaste'

function terminalSurface(): {
  surface: HTMLElement
  input: HTMLTextAreaElement
  cell: HTMLElement
} {
  const surface = document.createElement('div')
  surface.className = 'terminal-surface'
  const cell = document.createElement('div')
  const input = document.createElement('textarea')
  input.className = 'xterm-helper-textarea'
  surface.append(cell, input)
  document.body.append(surface)
  return { surface, input, cell }
}

function middleUp(target: Element): MouseEvent {
  const event = new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

describe('installMiddlePasteGuard', () => {
  let remove: () => void = () => {}
  beforeEach(() => {
    remove = installMiddlePasteGuard(window)
  })
  afterEach(() => {
    remove()
    document.body.replaceChildren()
  })

  it('blocks the paste when the middle click closes a tab while a terminal has focus', () => {
    const left = terminalSurface()
    left.input.focus()
    const tab = document.createElement('div')
    tab.className = 'pane-tab'
    document.body.append(tab)
    expect(middleUp(tab).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(left.input)
  })

  it('pastes into the terminal under the pointer, not the focused one beside it', () => {
    const left = terminalSurface()
    const right = terminalSurface()
    left.input.focus()
    expect(middleUp(right.cell).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(right.input)
  })

  it('leaves the paste alone in the focused terminal', () => {
    const left = terminalSurface()
    left.input.focus()
    expect(middleUp(left.cell).defaultPrevented).toBe(false)
    expect(document.activeElement).toBe(left.input)
  })

  it('pastes into a focused text field under the pointer', () => {
    terminalSurface()
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    expect(middleUp(field).defaultPrevented).toBe(false)
  })

  it('blocks the paste on a text field that does not hold focus', () => {
    const left = terminalSurface()
    left.input.focus()
    const field = document.createElement('input')
    document.body.append(field)
    expect(middleUp(field).defaultPrevented).toBe(true)
  })

  it('ignores other buttons and stops after removal', () => {
    const left = terminalSurface()
    left.input.focus()
    const tab = document.createElement('div')
    document.body.append(tab)
    const leftClick = new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true })
    tab.dispatchEvent(leftClick)
    expect(leftClick.defaultPrevented).toBe(false)
    remove()
    expect(middleUp(tab).defaultPrevented).toBe(false)
  })
})
