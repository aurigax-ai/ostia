import {
  type ChordSpec,
  parseChord,
  sameChord,
  specFromEvent,
} from '../../shared/keyboard/chordSpec'
import type { GuestKeyInput } from '../../shared/keyboard/clipboardChords'
import { guestKeyLike } from '../../shared/keyboard/guestChords'

export interface MenuNode {
  accelerator?: string | null
  registerAccelerator?: boolean
  submenu?: { items: readonly MenuNode[] } | null
}

function menuChords(items: readonly MenuNode[], out: ChordSpec[]): ChordSpec[] {
  for (const item of items) {
    if (item.accelerator && item.registerAccelerator !== false) {
      const spec = parseChord(item.accelerator.replace(/(?:command|cmd)orcontrol/i, 'Cmd'), true)
      if (spec) out.push(spec)
    }
    if (item.submenu) menuChords(item.submenu.items, out)
  }
  return out
}

export function createNativeMenuKey(
  items: () => readonly MenuNode[],
): (input: GuestKeyInput) => boolean {
  return (input) => {
    const spec = specFromEvent(guestKeyLike(input))
    if (!spec) return false
    return menuChords(items(), []).some((chord) => sameChord(chord, spec))
  }
}
