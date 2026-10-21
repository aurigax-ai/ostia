import type { KeyboardInputEvent } from 'electron'
import type { GuestKeyInput } from '../../shared/keyboard/clipboardChords'
import {
  isIdentityRemap,
  isRetargeted,
  type ModifierRemap,
  parseModifierRemap,
  type RemapKey,
  releaseStale,
  remappedFlags,
  remappedModifierKey,
  sameFlags,
  trackModifierKey,
} from '../../shared/keyboard/modifierRemap'
import { isInjecting } from './guestInject'
import { guestKeyEvents, guestKeyName } from './guestKeyEvent'

export interface GuestRemapDeps {
  nativeMenuKey: (input: GuestKeyInput) => boolean
}

export interface GuestRemap {
  set: (raw: unknown) => void
  remap: (guestId: number, input: GuestKeyInput) => GuestKeyInput
  rewrite: (guestId: number, input: GuestKeyInput) => KeyboardInputEvent[] | null
  forget: (guestId: number) => void
}

export function createGuestRemap(deps: GuestRemapDeps): GuestRemap {
  let table: ModifierRemap = {}
  const held = new Map<number, Set<RemapKey>>()

  const remap: GuestRemap['remap'] = (guestId, input) => {
    if (isInjecting(guestId)) return input
    if (input.type !== 'keyDown' && input.type !== 'keyUp') return input
    const down = held.get(guestId) ?? new Set<RemapKey>()
    held.set(guestId, down)
    trackModifierKey(down, input.code, input.type === 'keyDown')
    const real = { ctrl: input.control, alt: input.alt, meta: input.meta }
    releaseStale(down, real)
    if (isIdentityRemap(table)) return input
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
      if (isInjecting(guestId)) return null
      const mapped = remap(guestId, input)
      if (input.isComposing || input.key === 'Dead') return null
      const retargeted = isRetargeted(table, input.code)
      if (mapped === input && !retargeted) return null
      if (deps.nativeMenuKey(input)) return null
      const flags = { ctrl: mapped.control, alt: mapped.alt, meta: mapped.meta }
      const keyCode =
        remappedModifierKey(table, input.code) ?? guestKeyName(input.code, input.key, input.alt)
      return keyCode ? guestKeyEvents(input, keyCode, flags) : null
    },
  }
}
