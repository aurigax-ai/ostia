import type { ChordValue, KeybindingMap } from '@shared/chordSpec'
import type { TerminalKeyMap, TerminalSend } from '@shared/terminalKeys'
import { presetKeys, signatureOf } from './keyPresets'
import {
  type AppKeyChange,
  type TerminalKeyChange,
  appKeyChanges,
  terminalKeyChanges,
} from './presetDiff'

export interface CommandChange {
  id: string
  value: ChordValue | null
}

export interface TerminalChange {
  keys: string
  send: TerminalSend | null
}

export interface UserChanges {
  customCommands: CommandChange[]
  removedCommands: CommandChange[]
  customKeys: TerminalChange[]
  removedKeys: TerminalChange[]
}

export function userChanges(keybindings: KeybindingMap, terminalKeys: TerminalKeyMap): UserChanges {
  const commands = Object.entries(keybindings).map(([id, value]) => ({ id, value }))
  const keys = Object.entries(terminalKeys).map(([k, send]) => ({ keys: k, send }))
  return {
    customCommands: commands.filter((c) => c.value !== null),
    removedCommands: commands.filter((c) => c.value === null),
    customKeys: keys.filter((k) => k.send !== null),
    removedKeys: keys.filter((k) => k.send === null),
  }
}

export function userChangeCount(changes: UserChanges): number {
  return (
    changes.customCommands.length +
    changes.removedCommands.length +
    changes.customKeys.length +
    changes.removedKeys.length
  )
}

export function appPresetChanges(keymap: KeybindingMap, mac: boolean): AppKeyChange[] {
  return appKeyChanges({}, keymap, mac)
}

export function textPresetChanges(
  terminalKeymap: string | null,
  mac: boolean,
): TerminalKeyChange[] {
  return terminalKeyChanges(presetKeys(null, mac), presetKeys(terminalKeymap, mac), mac)
}

export function presetSendFor(
  keys: string,
  terminalKeymap: string | null,
  mac: boolean,
): TerminalSend | null {
  const signature = signatureOf(keys, mac)
  if (!signature) return null
  const found = Object.entries(presetKeys(terminalKeymap, mac)).find(
    ([k]) => signatureOf(k, mac) === signature,
  )
  return found?.[1] ?? null
}

export type PresetLayer = 'app' | 'text'

export interface PresetPreviewPlan<T> {
  changes: T[]
  keptCustom: T[]
}

export function appPreview(
  current: KeybindingMap,
  next: KeybindingMap,
  user: KeybindingMap,
  mac: boolean,
): PresetPreviewPlan<AppKeyChange> {
  const changes = appKeyChanges(current, next, mac)
  return { changes, keptCustom: changes.filter((c) => Object.hasOwn(user, c.id)) }
}

export function textPreview(
  current: string | null,
  next: string,
  user: TerminalKeyMap,
  mac: boolean,
): PresetPreviewPlan<TerminalKeyChange> {
  const changes = terminalKeyChanges(presetKeys(current, mac), presetKeys(next, mac), mac)
  const mine = Object.keys(user)
  return {
    changes,
    keptCustom: changes.filter((c) => mine.some((k) => signatureOf(k, mac) === c.signature)),
  }
}
