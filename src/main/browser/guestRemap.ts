import type { GuestKeyInput } from '../../shared/keyboard/clipboardChords'
import {
  type ModifierRemap,
  type RemapKey,
  isIdentityRemap,
  parseModifierRemap,
  remappedFlags,
  sameFlags,
  trackModifierKey,
} from '../../shared/keyboard/modifierRemap'

export interface GuestRemap {
  set: (raw: unknown) => void
  remap: (guestId: number, input: GuestKeyInput) => GuestKeyInput
  forget: (guestId: number) => void
}

export function createGuestRemap(): GuestRemap {
  let table: ModifierRemap = {}
  const held = new Map<number, Set<RemapKey>>()

  return {
    set: (raw) => {
      table = parseModifierRemap(raw)
    },
    forget: (guestId) => {
      held.delete(guestId)
    },
    remap: (guestId, input) => {
      if (input.type !== 'keyDown' && input.type !== 'keyUp') return input
      const down = held.get(guestId) ?? new Set<RemapKey>()
      held.set(guestId, down)
      trackModifierKey(down, input.code, input.type === 'keyDown')
      if (isIdentityRemap(table)) return input
      const real = { ctrl: input.control, alt: input.alt, meta: input.meta }
      const next = remappedFlags(table, down, real)
      if (sameFlags(real, next)) return input
      return { ...input, control: next.ctrl, alt: next.alt, meta: next.meta, remapped: true }
    },
  }
}
