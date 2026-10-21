import { CHORDS_PER_COMMAND_MAX } from '@shared/keyboard/chordSpec'
import {
  KEYBOARD_PLATFORMS,
  type KeyboardPlatform,
  OSTIA_KEYMAP,
  TERMINAL_KEYMAPS,
} from '@/lib/keyboard/keyboardPresets'
import { TERMINAL_SEND_MAX, TERMINAL_SEND_TYPES } from '@/lib/keyboard/terminalKeys'
import { KEYMAP_SETTING_PATTERN } from './keymapSetting'

const CHORD_VALUE = {
  type: ['string', 'array', 'null'],
  items: { type: 'string' },
  maxItems: CHORDS_PER_COMMAND_MAX,
  description:
    'A chord like "Ctrl+Shift+K", "Cmd+Alt+P" or "Mod+Shift+K" (Mod is Cmd on macOS, Ctrl ' +
    'elsewhere), a list of chords that all run the command (menus show the first one that ' +
    'works everywhere), or null to unbind. A chord written "terminal:Cmd+K" runs the ' +
    'command only while a terminal has the focus, and elsewhere the key keeps its other ' +
    'use. "Shift+Shift" is Shift pressed twice on its own. Chords the shell needs are ' +
    'ignored: plain Ctrl+letter, plain or Ctrl arrows, Escape, Tab and keys without Ctrl/Cmd.',
}

export function keybindingsSchema(ids: readonly string[]) {
  return {
    type: 'object',
    description:
      'Keyboard shortcuts: command id → chord, list of chords, or null to unbind. Unlisted ' +
      'commands keep their default. Edit them in Settings → Keyboard.',
    properties: Object.fromEntries(ids.map((id) => [id, CHORD_VALUE])),
    additionalProperties: CHORD_VALUE,
  }
}

export const KEYMAP_VALUE = {
  type: 'string',
  pattern: KEYMAP_SETTING_PATTERN.source,
  examples: [OSTIA_KEYMAP, 'keymap-macos/cmux'],
  description:
    '"ostia" for the default command shortcuts, or a keymap an enabled extension contributes ' +
    '(contributes.keymaps), as "<extension id>/<keymap id>": its chords replace the default ' +
    'command shortcuts, and your keybindings apply on top. An id no enabled extension offers ' +
    'on this computer counts as "ostia".',
}

export const TERMINAL_KEYMAP_VALUE = {
  type: 'string',
  enum: TERMINAL_KEYMAPS.map((k) => k.id),
  description:
    '"ostia": line and word editing with Cmd and Option on macOS, and with Ctrl and Alt plus ' +
    'Ctrl+Backspace on Linux. "natural-text-editing": the keys of iTerm2’s Natural Text ' +
    'Editing preset (macOS). "none": keys go to the terminal as typed, for shells in vi mode. ' +
    'A preset this platform doesn’t have counts as its default ("ostia").',
}

export const TERMINAL_KEYS_VALUE = {
  type: 'object',
  description:
    'Chord → what to send, or null to drop a key the text editing preset sends. They apply ' +
    'on top of the preset; a command bound to the same chord wins.',
  additionalProperties: {
    oneOf: [
      { type: 'null' },
      {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'value'],
        properties: {
          type: {
            type: 'string',
            enum: [...TERMINAL_SEND_TYPES],
            description:
              '"text": the value, with \\n \\r \\t \\e \\\\ and \\xHH escapes. ' +
              '"escape": ESC, then the value. "hex": bytes like "0x1b 0x7f" (0x00-0x7f).',
          },
          value: { type: 'string', minLength: 1, maxLength: TERMINAL_SEND_MAX },
        },
      },
    ],
  },
}

export const KEYBINDINGS_DESC =
  'Your keyboard shortcuts for each platform ("mac", "linux"): command id → chord, or null ' +
  'to unbind. Unlisted commands keep their default. Edit them in Settings → Keyboard.'

export function perPlatformSchema<T>(description: string, value: T) {
  const properties = Object.fromEntries(KEYBOARD_PLATFORMS.map((p) => [p, value]))
  return {
    type: 'object',
    description,
    additionalProperties: false,
    properties: properties as Record<KeyboardPlatform, T>,
  }
}
