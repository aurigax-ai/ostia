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
  if (letter) return !alt && /^[A-Za-z]$/.test(key) ? key.toUpperCase() : letter[1]
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1]
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return NAMED_KEYS.get(code) ?? null
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
  if (down && !flags.ctrl && !flags.meta && input.key.length === 1) {
    events.push({ type: 'char', keyCode: input.key, modifiers })
  }
  return events
}
