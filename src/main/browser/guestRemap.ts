import type { KeyboardInputEvent } from 'electron'
import type { GuestKeyInput } from '../../shared/keyboard/clipboardChords'
import {
  type ModifierRemap,
  type RemapKey,
  isIdentityRemap,
  isRetargeted,
  parseModifierRemap,
  remappedFlags,
  remappedModifierKey,
  sameFlags,
  trackModifierKey,
} from '../../shared/keyboard/modifierRemap'
import { guestKeyEvent, guestKeyName } from './guestKeyEvent'

export interface GuestRemapDeps {
  nativeMenuKey: (input: GuestKeyInput) => boolean
}

export interface GuestRemap {
  set: (raw: unknown) => void
  remap: (guestId: number, input: GuestKeyInput) => GuestKeyInput
  rewrite: (guestId: number, input: GuestKeyInput) => KeyboardInputEvent | null
  inject: (guestId: number, send: () => void) => void
  forget: (guestId: number) => void
}

export function createGuestRemap(deps: GuestRemapDeps): GuestRemap {
  let table: ModifierRemap = {}
  const held = new Map<number, Set<RemapKey>>()
  const injecting = new Set<number>()

  const remap: GuestRemap['remap'] = (guestId, input) => {
    if (injecting.has(guestId)) return input
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return input
    const down = held.get(guestId) ?? new Set<RemapKey>()
    held.set(guestId, down)
    trackModifierKey(down, input.code, input.type === 'keyDown')
    if (isIdentityRemap(table)) return input
    const real = { ctrl: input.control, alt: input.alt, meta: input.meta }
    const next = remappedFlags(table, down, real)
    if (sameFlags(real, next)) return input
    return { ...input, control: next.ctrl, alt: next.alt, meta: next.meta, remapped: true }
  }

  return {
    set: (raw) => {
      table = parseModifierRemap(raw)
    },
    forget: (guestId) => {
      held.delete(guestId)
    },
    remap,
    rewrite: (guestId, input) => {
      if (injecting.has(guestId)) return null
      const mapped = remap(guestId, input)
      if (input.isComposing || input.key === 'Dead') return null
      const retargeted = isRetargeted(table, input.code)
      if (mapped === input && !retargeted) return null
      if (deps.nativeMenuKey(input)) return null
      const flags = { ctrl: mapped.control, alt: mapped.alt, meta: mapped.meta }
      const keyCode = remappedModifierKey(table, input.code) ?? guestKeyName(input.code)
      return keyCode ? guestKeyEvent(input, keyCode, flags) : null
    },
    inject: (guestId, send) => {
      injecting.add(guestId)
      try {
        send()
      } finally {
        injecting.delete(guestId)
      }
    },
  }
}
