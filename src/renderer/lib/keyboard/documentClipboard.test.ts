import { parseChord } from '@shared/keyboard/chordSpec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeCapture, openCapture } from '@/lib/capture/captureSession'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  documentEdit,
  handleDocumentBeforeCopy,
  handleDocumentClipboardChord,
  handleDocumentCopyEvent,
  isEditableElement,
  syncClipboardChords,
} from './documentClipboard'
import { installModifierRemap, setActiveModifierRemap } from './modifierRemapEvents'

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

describe('handleDocumentClipboardChord with a modifier remap on macOS', () => {
  it('copies for a key remapped to Command and still leaves a real Cmd+C to the system menu', () => {
    const uninstall = installModifierRemap()
    try {
      setActiveModifierRemap({ ControlRight: 'command' })
      listen(true)
      const input = document.createElement('input')
      document.body.append(input)
      input.focus()
      expect(press(input, { key: 'c', code: 'KeyC', metaKey: true }).defaultPrevented).toBe(false)
      press(input, { key: 'Control', code: 'ControlRight', ctrlKey: true })
      expect(press(input, { key: 'c', code: 'KeyC', ctrlKey: true }).defaultPrevented).toBe(true)
      expect(window.ostia.clipboard.edit).toHaveBeenCalledWith('copy')
    } finally {
      uninstall()
    }
  })

  it('copies once for Option remapped to Command even though Option+C types a cedilla', () => {
    const uninstall = installModifierRemap()
    try {
      setActiveModifierRemap({ AltLeft: 'command' })
      listen(true)
      const input = document.createElement('input')
      document.body.append(input)
      input.focus()
      press(input, { key: 'Alt', code: 'AltLeft', altKey: true })
      expect(press(input, { key: 'ç', code: 'KeyC', altKey: true }).defaultPrevented).toBe(true)
      expect(window.ostia.clipboard.edit).toHaveBeenCalledTimes(1)
      expect(window.ostia.clipboard.edit).toHaveBeenCalledWith('copy')
    } finally {
      uninstall()
    }
  })
})

describe('the pane copier registry', () => {
  const layoutBefore = useLayoutStore.getState()
  const workspacesBefore = useWorkspacesStore.getState()

  beforeEach(() => {
    useWorkspacesStore.setState({ activeWorkspaceId: 'w1' })
    useLayoutStore.setState({ byWorkspace: { w1: { activePaneId: 'p1' } as never } })
  })

  function hold(copy: () => void): () => void {
    openCapture('p1', {
      anchor: null,
      takeFocus: true,
      highlight: null,
      copy: async () => {
        copy()
        return { ok: true, status: 'Copied.' }
      },
      send: async () => ({ ok: true, inserted: true }),
      clear: () => undefined,
    })
    return () => closeCapture('p1', 'source-gone')
  }

  afterEach(() => {
    useLayoutStore.setState(layoutBefore, true)
    useWorkspacesStore.setState(workspacesBefore, true)
  })

  it('answers the copy chord before the native copy', () => {
    listen()
    const copy = vi.fn()
    const off = hold(copy)
    const text = document.createElement('p')
    document.body.append(text)
    expect(press(text, copyChord).defaultPrevented).toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(window.ostia.clipboard.edit).not.toHaveBeenCalled()
    off()
  })

  it('leaves a text field to the native copy', () => {
    listen()
    const copy = vi.fn()
    const off = hold(copy)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    press(input, copyChord)
    expect(copy).not.toHaveBeenCalled()
    expect(window.ostia.clipboard.edit).toHaveBeenCalledWith('copy')
    off()
  })

  it('takes the copy event when the pane has something, and lets it through when not', () => {
    const off = hold(vi.fn())
    const taken = new Event('copy', { cancelable: true }) as ClipboardEvent
    handleDocumentCopyEvent(taken)
    expect(taken.defaultPrevented).toBe(true)
    off()
    const passed = new Event('copy', { cancelable: true }) as ClipboardEvent
    handleDocumentCopyEvent(passed)
    expect(passed.defaultPrevented).toBe(false)
  })

  it('enables the copy command with beforecopy while the pane has a copier, never in a text field', () => {
    const off = hold(() => undefined)
    const enabled = new Event('beforecopy', { cancelable: true })
    handleDocumentBeforeCopy(enabled)
    expect(enabled.defaultPrevented).toBe(true)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    const typing = new Event('beforecopy', { cancelable: true })
    handleDocumentBeforeCopy(typing)
    expect(typing.defaultPrevented).toBe(false)
    input.remove()
    off()
    const none = new Event('beforecopy', { cancelable: true })
    handleDocumentBeforeCopy(none)
    expect(none.defaultPrevented).toBe(false)
  })

  it('routes the native Cmd+C on macOS to the copier and leaves it native without one', () => {
    listen(true)
    const text = document.createElement('p')
    document.body.append(text)
    const cmdC = { key: 'c', code: 'KeyC', metaKey: true }
    expect(press(text, cmdC).defaultPrevented).toBe(false)
    const copy = vi.fn()
    const off = hold(copy)
    expect(press(text, cmdC).defaultPrevented).toBe(true)
    expect(copy).toHaveBeenCalledTimes(1)
    expect(window.ostia.clipboard.edit).not.toHaveBeenCalled()
    off()
  })

  it('leaves Cmd+C in a text field native on macOS even with a copier', () => {
    listen(true)
    const copy = vi.fn()
    const off = hold(copy)
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    expect(press(input, { key: 'c', code: 'KeyC', metaKey: true }).defaultPrevented).toBe(false)
    expect(copy).not.toHaveBeenCalled()
    off()
  })
})
