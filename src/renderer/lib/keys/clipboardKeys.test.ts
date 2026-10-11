import { describe, expect, it } from 'vitest'
import {
  isStubText,
  keyPastePlan,
  pasteEventReadsClipboard,
  smartClipboardAction,
} from './clipboardKeys'

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
  const table = 'Name\tQty\napples\t3\npears\t5'

  it('pastes clipboard text when nothing else is on the clipboard', () => {
    expect(keyPastePlan('ls', false, none)).toBe('text')
  })

  it('hands Ctrl+V to the program when the clipboard holds only an image', () => {
    expect(keyPastePlan('', false, image)).toBe('program')
  })

  it('pastes the path of a copied file, with or without text and an image beside it', () => {
    expect(keyPastePlan('', false, file)).toBe('files')
    expect(keyPastePlan('', false, fileAndImage)).toBe('files')
    expect(keyPastePlan('shot.png', false, file)).toBe('files')
    expect(keyPastePlan('some words', false, fileAndImage)).toBe('files')
  })

  it('hands Ctrl+V to the program for an image whose text is only a file name or a URL', () => {
    expect(keyPastePlan('Screenshot 2026-10-11 at 10.00.00.png', false, image)).toBe('program')
    expect(keyPastePlan('https://example.com/a.png', false, image)).toBe('program')
  })

  it('pastes the text of a spreadsheet or slide copy that carries an image preview', () => {
    expect(keyPastePlan(table, false, image)).toBe('text')
    expect(keyPastePlan('hello', false, image)).toBe('text')
    expect(keyPastePlan('3.14', false, image)).toBe('text')
    expect(keyPastePlan('two words here', false, image)).toBe('text')
  })

  it('pastes only text while the input editor shows, and nothing for an empty clipboard', () => {
    expect(keyPastePlan('ls', true, fileAndImage)).toBe('text')
    expect(keyPastePlan('', true, fileAndImage)).toBe('none')
    expect(keyPastePlan('', true, image)).toBe('none')
    expect(keyPastePlan('', false, none)).toBe('none')
  })
})

describe('isStubText', () => {
  it('takes an empty string, one file name and one URL for a stub', () => {
    for (const text of ['', '  \n', 'a.png', 'my shot.PNG', 'ftp://host/x', 'https://a.b/c?d=1']) {
      expect(isStubText(text)).toBe(true)
    }
  })

  it('does not take real content for a stub', () => {
    for (const text of [
      'hello',
      '3.14',
      'a.png\nb.png',
      'see https://a.b now',
      '.png',
      'dir/a.png',
    ]) {
      expect(isStubText(text)).toBe(false)
    }
  })
})

describe('pasteEventReadsClipboard', () => {
  it('reads the clipboard itself on macOS so a file or an image reaches the program whatever text comes with it', () => {
    expect(pasteEventReadsClipboard(false, true)).toBe(true)
  })

  it('leaves a paste into the input editor, and any paste off macOS, to the usual path', () => {
    expect(pasteEventReadsClipboard(true, true)).toBe(false)
    expect(pasteEventReadsClipboard(false, false)).toBe(false)
  })
})
