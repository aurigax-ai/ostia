import type { KeyboardInputEvent } from 'electron'
import type { GuestKeyInput } from '../../shared/keyboard/clipboardChords'
import type { ModifierFlags } from '../../shared/keyboard/modifierRemap'

const NAMED_KEYS: ReadonlyMap<string, string> = new Map([
  ['ShiftLeft', 'Shift'],
  ['ShiftRight', 'Shift'],
  ['Space', 'Space'],
  ['Enter', 'Enter'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Escape', 'Escape'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['ArrowLeft', 'Left'],
  ['ArrowRight', 'Right'],
  ['ArrowUp', 'Up'],
  ['ArrowDown', 'Down'],
])

const CHARACTER_KEYS: ReadonlyMap<string, string> = new Map([
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Backquote', '`'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
])

export function guestKeyName(code: string, key: string, alt: boolean): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  const digit = /^Digit([0-9])$/.exec(code)
  const character = letter?.[1] ?? digit?.[1] ?? CHARACTER_KEYS.get(code)
  if (character) return !alt && /^[\x21-\x7e]$/.test(key) ? key.toUpperCase() : character
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return NAMED_KEYS.get(code) ?? null
}

function typedText(key: string): string | null {
  if (key === 'Enter') return '\r'
  return key.length === 1 ? key : null
}

export function guestKeyEvents(
  input: GuestKeyInput,
  keyCode: string,
  flags: ModifierFlags,
): KeyboardInputEvent[] {
  const modifiers: NonNullable<KeyboardInputEvent['modifiers']> = []
  if (input.shift) modifiers.push('shift')
  if (flags.ctrl) modifiers.push('control')
  if (flags.alt) modifiers.push('alt')
  if (flags.meta) modifiers.push('meta')
  if (input.isAutoRepeat) modifiers.push('isautorepeat')
  const down = input.type === 'keyDown'
  const events: KeyboardInputEvent[] = [{ type: down ? 'keyDown' : 'keyUp', keyCode, modifiers }]
  const text = typedText(input.key)
  if (down && !flags.ctrl && !flags.meta && text) {
    events.push({ type: 'char', keyCode: text, modifiers })
  }
  return events
}
