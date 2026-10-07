import { type ChordProblem, chordText, parseChord } from '@shared/chordSpec'
import type { TerminalSend } from '@shared/terminalKeys'
import { commandWording, commands } from '../commands/registry'
import type { Dict } from '../i18n/dict'
import { sendActionKey } from '../lib/presetDiff'

const TERMINAL_TITLES: Record<string, (d: Dict) => string> = {
  copy: (d) => d.keyboard.copy,
  paste: (d) => d.keyboard.paste,
  find: (d) => d.keyboard.find,
  'find.next': (d) => d.keyboard.findNext,
  'find.previous': (d) => d.keyboard.findPrevious,
}

export function commandTitle(id: string, d: Dict): string {
  const terminal = TERMINAL_TITLES[id]
  if (terminal) return terminal(d)
  const registered = commands.list().find((c) => c.id === id)
  if (registered) return commandWording(registered, d).title
  return (d.commands.titles as Record<string, string | undefined>)[id] ?? id
}

export function sendText(send: TerminalSend): string {
  return send.type === 'escape' ? `ESC ${send.value}` : send.value
}

export function sendActionText(send: TerminalSend, d: Dict): string | null {
  const key = sendActionKey(send)
  return key ? d.keyboard.sendActions[key] : null
}

export function sendLabel(send: TerminalSend, d: Dict): string {
  return sendActionText(send, d) ?? sendText(send)
}

export function appKeymapLabel(id: string, d: Dict): string {
  return (d.keyboard.appKeymaps as Record<string, string | undefined>)[id] ?? id
}

export function terminalKeymapLabel(id: string, d: Dict): string {
  return (d.keyboard.terminalKeymaps as Record<string, string | undefined>)[id] ?? id
}

export const KEY_TABLE_COLUMNS = ['w-[42%]', 'w-[36%]', 'w-[22%]'] as const

export function problemText(problem: ChordProblem, d: Dict, mac: boolean): string {
  const p = d.keyboard.problems
  switch (problem) {
    case 'invalid':
      return p.invalid
    case 'escape':
      return p.escape
    case 'tab':
      return p.tab
    case 'bare':
      return p.bare
    case 'needs-modifier':
      return mac ? p.needsModifierMac : p.needsModifier
    case 'ctrl-key':
      return p.ctrlKey
    case 'arrow':
      return p.arrow
    case 'digit-range':
      return p.digitRange
  }
}

export function keysLabel(keys: string, mac: boolean): string {
  const spec = parseChord(keys, mac)
  return spec ? chordText(spec, mac) : keys
}
