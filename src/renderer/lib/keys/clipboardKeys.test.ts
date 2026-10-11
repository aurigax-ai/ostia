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
  const none = { files: [], image: false }
  const image = { files: [], image: true }
  const file = { files: ['/tmp/a.png'], image: false }
  const fileAndImage = { files: ['/tmp/a.png'], image: true }

  it('pastes clipboard text whenever there is some', () => {
    expect(keyPastePlan('ls', false, image)).toBe('text')
    expect(keyPastePlan('ls', true, none)).toBe('text')
    expect(keyPastePlan('ls', false, fileAndImage)).toBe('text')
  })

  it('hands Ctrl+V to the program when the clipboard holds only an image', () => {
    expect(keyPastePlan('', false, image)).toBe('program')
  })

  it('pastes the path of a copied file, even when the clipboard also holds its image', () => {
    expect(keyPastePlan('', false, file)).toBe('files')
    expect(keyPastePlan('', false, fileAndImage)).toBe('files')
  })

  it('does nothing for a file or an image while the input editor shows, or for an empty clipboard', () => {
    expect(keyPastePlan('', true, image)).toBe('none')
    expect(keyPastePlan('', true, fileAndImage)).toBe('none')
    expect(keyPastePlan('', false, none)).toBe('none')
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
