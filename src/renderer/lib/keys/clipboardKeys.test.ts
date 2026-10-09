import { describe, expect, it } from 'vitest'
import { keyPastePlan, pasteEventReadsClipboard, smartClipboardAction } from './clipboardKeys'

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

describe('smartClipboardAction', () => {
  it('copies on Ctrl+C only with a selection, so Ctrl+C still interrupts otherwise', () => {
    expect(smartClipboardAction(key('c', { ctrlKey: true }), 'smart', true, false)).toBe('copy')
    expect(smartClipboardAction(key('c', { ctrlKey: true }), 'smart', false, false)).toBeNull()
  })

  it('pastes on Ctrl+V in smart mode', () => {
    expect(smartClipboardAction(key('v', { ctrlKey: true }), 'smart', false, false)).toBe('paste')
  })

  it('leaves the keys to the shell in shift mode, on macOS, and with other modifiers', () => {
    expect(smartClipboardAction(key('c', { ctrlKey: true }), 'shift', true, false)).toBeNull()
    expect(smartClipboardAction(key('v', { ctrlKey: true }), 'smart', false, true)).toBeNull()
    expect(
      smartClipboardAction(key('C', { ctrlKey: true, shiftKey: true }), 'smart', true, false),
    ).toBeNull()
    expect(smartClipboardAction(key('r', { ctrlKey: true }), 'smart', false, false)).toBeNull()
  })
})

describe('keyPastePlan', () => {
  it('pastes clipboard text whenever there is some', () => {
    expect(keyPastePlan('ls', false, true)).toBe('text')
    expect(keyPastePlan('ls', true, false)).toBe('text')
  })

  it('hands Ctrl+V to the program when the clipboard holds only an image', () => {
    expect(keyPastePlan('', false, true)).toBe('program')
  })

  it('does nothing for an image while the input editor shows, or for an empty clipboard', () => {
    expect(keyPastePlan('', true, true)).toBe('none')
    expect(keyPastePlan('', false, false)).toBe('none')
  })
})

describe('pasteEventReadsClipboard', () => {
  it('reads the clipboard itself on macOS when the native paste carries no text, so an image reaches the program', () => {
    expect(pasteEventReadsClipboard('', false, true)).toBe(true)
  })

  it('leaves a paste with text, one into the input editor, and any paste off macOS to the usual path', () => {
    expect(pasteEventReadsClipboard('ls', false, true)).toBe(false)
    expect(pasteEventReadsClipboard('', true, true)).toBe(false)
    expect(pasteEventReadsClipboard('', false, false)).toBe(false)
  })
})
