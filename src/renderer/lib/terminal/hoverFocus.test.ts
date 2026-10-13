import { afterEach, describe, expect, it } from 'vitest'
import { canFocusOnHover } from './hoverFocus'

afterEach(() => {
  document.body.innerHTML = ''
})

function focused(html: string, selector: string): void {
  document.body.innerHTML = html
  document.querySelector<HTMLElement>(selector)?.focus()
}

describe('canFocusOnHover', () => {
  it('allows focus moves when nothing is focused', () => {
    expect(canFocusOnHover(document)).toBe(true)
  })

  it('refuses while a text field has focus', () => {
    focused('<input id="f" />', '#f')
    expect(canFocusOnHover(document)).toBe(false)
  })

  it('allows focus moves away from a terminal or editor input', () => {
    focused('<textarea class="xterm-helper-textarea" id="t"></textarea>', '#t')
    expect(canFocusOnHover(document)).toBe(true)
    focused('<div class="monaco-editor"><textarea id="m"></textarea></div>', '#m')
    expect(canFocusOnHover(document)).toBe(true)
  })

  it('refuses while a dialog or the palette is open', () => {
    document.body.innerHTML = '<div role="dialog"></div>'
    expect(canFocusOnHover(document)).toBe(false)
    document.body.innerHTML = '<div cmdk-root=""></div>'
    expect(canFocusOnHover(document)).toBe(false)
  })
})
