import { useSettingsStore } from '@/stores/settingsStore'
import { parseChord } from '@shared/keyboard/chordSpec'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  documentEdit,
  handleDocumentClipboardChord,
  isEditableElement,
  syncClipboardChords,
} from './documentClipboard'

const initialSettings = useSettingsStore.getState()

let listener: ((e: KeyboardEvent) => void) | null = null

function listen(mac = false): void {
  listener = (e) => {
    handleDocumentClipboardChord(e, mac)
  }
  window.addEventListener('keydown', listener)
}

function press(target: Element, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

const copyChord = { key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }
const pasteChord = { key: 'V', code: 'KeyV', ctrlKey: true, shiftKey: true }

beforeEach(() => {
  document.body.innerHTML = ''
})

afterEach(() => {
  if (listener) window.removeEventListener('keydown', listener)
  listener = null
  useSettingsStore.setState(initialSettings, true)
  document.getSelection()?.removeAllRanges()
})

describe('handleDocumentClipboardChord', () => {
  it('copies and pastes through main in a focused text field', () => {
    listen()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(press(input, copyChord).defaultPrevented).toBe(true)
    expect(press(input, pasteChord).defaultPrevented).toBe(true)
    expect(window.ostia.clipboard.edit).toHaveBeenNthCalledWith(1, 'copy')
    expect(window.ostia.clipboard.edit).toHaveBeenNthCalledWith(2, 'paste')
  })

  it('copies the document selection outside a text field and never pastes there', () => {
    listen()
    const text = document.createElement('p')
    text.textContent = 'rendered chat answer'
    document.body.append(text)
    const range = document.createRange()
    range.selectNodeContents(text)
    document.getSelection()?.addRange(range)
    press(text, copyChord)
    press(text, pasteChord)
    expect(window.ostia.clipboard.edit).toHaveBeenCalledTimes(1)
    expect(window.ostia.clipboard.edit).toHaveBeenCalledWith('copy')
  })

  it('leaves a chord the focused surface already handled', () => {
    listen()
    const input = document.createElement('textarea')
    document.body.append(input)
    input.focus()
    input.addEventListener('keydown', (e) => e.preventDefault())
    press(input, copyChord)
    expect(window.ostia.clipboard.edit).not.toHaveBeenCalled()
  })

  it('follows a rebound copy chord and drops the old one', () => {
    useSettingsStore.setState({ keybindings: { copy: 'Ctrl+Alt+C' } })
    listen()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(press(input, copyChord).defaultPrevented).toBe(false)
    press(input, { key: 'c', code: 'KeyC', ctrlKey: true, altKey: true })
    expect(window.ostia.clipboard.edit).toHaveBeenCalledWith('copy')
    expect(window.ostia.clipboard.edit).toHaveBeenCalledTimes(1)
  })

  it('leaves plain Ctrl+C and Ctrl+V and the native macOS keys alone', () => {
    listen(true)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(press(input, { key: 'c', code: 'KeyC', metaKey: true }).defaultPrevented).toBe(false)
    expect(press(input, { key: 'v', code: 'KeyV', metaKey: true }).defaultPrevented).toBe(false)
    window.removeEventListener('keydown', listener as (e: KeyboardEvent) => void)
    listen(false)
    expect(press(input, { key: 'c', code: 'KeyC', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press(input, { key: 'v', code: 'KeyV', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(window.ostia.clipboard.edit).not.toHaveBeenCalled()
  })
})

describe('documentEdit', () => {
  it('copies and pastes in a text field, copies only a selection elsewhere', () => {
    expect(documentEdit('paste', { editable: true, hasSelection: false })).toBe('paste')
    expect(documentEdit('copy', { editable: true, hasSelection: false })).toBe('copy')
    expect(documentEdit('copy', { editable: false, hasSelection: true })).toBe('copy')
    expect(documentEdit('copy', { editable: false, hasSelection: false })).toBeNull()
    expect(documentEdit('paste', { editable: false, hasSelection: true })).toBeNull()
  })
})

describe('isEditableElement', () => {
  it('treats text inputs, textareas and EditContext hosts as editable, other controls not', () => {
    const text = document.createElement('input')
    const box = document.createElement('input')
    box.type = 'checkbox'
    const area = document.createElement('textarea')
    expect(isEditableElement(text)).toBe(true)
    expect(isEditableElement(box)).toBe(false)
    expect(isEditableElement(area)).toBe(true)
    expect(isEditableElement(document.createElement('button'))).toBe(false)
    const monaco = Object.assign(document.createElement('div'), { editContext: {} })
    expect(isEditableElement(monaco)).toBe(true)
    expect(isEditableElement(null)).toBe(false)
  })
})

describe('syncClipboardChords', () => {
  it('sends the copy and paste chords to main now and after a rebind', () => {
    const stop = syncClipboardChords(false)
    expect(window.ostia.clipboard.setChords).toHaveBeenLastCalledWith({
      copy: parseChord('Ctrl+Shift+C', false),
      paste: parseChord('Ctrl+Shift+V', false),
    })
    useSettingsStore.setState({ keybindings: { paste: 'Ctrl+Alt+V', copy: null } })
    expect(window.ostia.clipboard.setChords).toHaveBeenLastCalledWith({
      copy: null,
      paste: parseChord('Ctrl+Alt+V', false),
    })
    stop()
  })
})
