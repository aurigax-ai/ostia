import {
  CHORDS_PER_COMMAND_MAX,
  type ChordSpec,
  type ChordValue,
  type KeybindingMap,
  formatScopedChord,
  sameChord,
  sameScope,
} from '@shared/chordSpec'
import type { TerminalKeyMap, TerminalSend } from '@shared/terminalKeys'
import { sendData } from '@shared/terminalKeys'
import { defaultChords, specsOf } from './chords'
import {
  type TerminalKeyRow,
  presetKeys,
  signatureOf,
  terminalKeyTable,
  terminalKeymapOf,
} from './keyPresets'

export type KeySource = 'default' | 'preset' | 'user'

export type Layer = readonly ChordSpec[] | 'unbound' | null

export interface CommandSources {
  id: string
  ostia: readonly ChordSpec[]
  preset: Layer
  user: Layer
  effective: readonly ChordSpec[]
  source: KeySource
  label: KeySource | null
  dropped: readonly ChordSpec[]
}

const sameSpec = (a: ChordSpec, b: ChordSpec): boolean => sameChord(a, b) && sameScope(a, b)

export function sameChordSet(a: readonly ChordSpec[], b: readonly ChordSpec[]): boolean {
  return a.length === b.length && a.every((x) => b.some((y) => sameSpec(x, y)))
}

export function layerOf(map: KeybindingMap, id: string, mac: boolean): Layer {
  if (!Object.hasOwn(map, id)) return null
  const value = map[id]
  if (value === null) return 'unbound'
  const specs = specsOf(value, mac, id)
  return specs.length > 0 ? specs : null
}

const chordsIn = (layer: Exclude<Layer, null>): readonly ChordSpec[] =>
  layer === 'unbound' ? [] : layer

export function commandSources(
  id: string,
  user: KeybindingMap,
  keymap: KeybindingMap,
  mac: boolean,
): CommandSources {
  const ostia = defaultChords(id, mac)
  const preset = layerOf(keymap, id, mac)
  const mine = layerOf(user, id, mac)
  const source: KeySource = mine !== null ? 'user' : preset !== null ? 'preset' : 'default'
  const effective =
    mine !== null ? chordsIn(mine) : preset !== null ? chordsIn(preset) : (ostia as ChordSpec[])
  const changed = !sameChordSet(effective, ostia)
  const label: KeySource | null =
    source === 'user' ? 'user' : source === 'preset' && changed ? 'preset' : null
  const dropped = ostia.filter((o) => !effective.some((e) => sameSpec(o, e)))
  return { id, ostia, preset, user: mine, effective, source, label, dropped }
}

function formatted(specs: readonly ChordSpec[], mac: boolean): string[] {
  const out: ChordSpec[] = []
  for (const spec of specs) if (!out.some((s) => sameSpec(s, spec))) out.push(spec)
  return out.map((spec) => formatScopedChord(spec, mac))
}

export function withChordReplaced(
  current: readonly ChordSpec[],
  index: number,
  spec: ChordSpec,
  mac: boolean,
): string[] {
  if (index < 0 || index >= current.length) return formatted(current, mac)
  const next = current.map((old, i) => (i === index ? { ...spec, terminal: old.terminal } : old))
  return formatted(next, mac)
}

export function withChordRemoved(
  current: readonly ChordSpec[],
  index: number,
  mac: boolean,
): string[] {
  return formatted(
    current.filter((_, i) => i !== index),
    mac,
  )
}

export function withChordAdded(
  current: readonly ChordSpec[],
  spec: ChordSpec,
  mac: boolean,
): string[] {
  return formatted([...current, spec], mac).slice(0, CHORDS_PER_COMMAND_MAX)
}

export function canAddChord(current: readonly ChordSpec[]): boolean {
  return current.length < CHORDS_PER_COMMAND_MAX
}

export type Override = { reset: true } | { reset: false; value: ChordValue | null }

export function overrideFor(
  next: readonly string[],
  base: readonly ChordSpec[],
  mac: boolean,
): Override {
  const specs = specsOf([...next], mac)
  if (sameChordSet(specs, base)) return { reset: true }
  if (next.length === 0) return { reset: false, value: null }
  return { reset: false, value: next.length === 1 ? next[0] : [...next] }
}

export interface TerminalKeySources {
  row: TerminalKeyRow
  ostia: TerminalSend | null
  source: KeySource
  label: KeySource | null
}

export function terminalKeySources(
  user: TerminalKeyMap,
  terminalKeymap: string | null,
  mac: boolean,
): TerminalKeySources[] {
  const defaultKeymap = terminalKeymapOf(null, mac)
  const chosen = terminalKeymapOf(terminalKeymap, mac)
  const ostiaBySignature = new Map<string, TerminalSend>()
  for (const [keys, send] of Object.entries(presetKeys(defaultKeymap, mac))) {
    const signature = signatureOf(keys, mac)
    if (signature) ostiaBySignature.set(signature, send)
  }
  return terminalKeyTable(user, terminalKeymap, mac).rows.map((row) => {
    const ostia = ostiaBySignature.get(row.signature) ?? null
    const source: KeySource = row.userKey ? 'user' : chosen === defaultKeymap ? 'default' : 'preset'
    const sameAsOstia = ostia !== null && sendData(ostia) === row.data
    const label: KeySource | null =
      source === 'user' ? 'user' : source === 'preset' && !sameAsOstia ? 'preset' : null
    return { row, ostia, source, label }
  })
}

export const COMMAND_GROUPS = [
  'workspace',
  'pane',
  'terminal',
  'view',
  'app',
  'browser',
  'other',
] as const

export type CommandGroup = (typeof COMMAND_GROUPS)[number]

const GROUP_BY_ID: Readonly<Record<string, CommandGroup>> = {
  'window.new': 'workspace',
  'tab.new': 'workspace',
  'tab.next': 'workspace',
  'tab.previous': 'workspace',
  'tab.moveLeft': 'workspace',
  'tab.moveRight': 'workspace',
  'app.quit': 'app',
  'app.openSettings': 'app',
  'palette.toggle': 'app',
  'attention.jumpToLatest': 'app',
  'history.search': 'app',
  'workflows.search': 'app',
  'agent.resume': 'app',
  'selection.sendToAgent': 'app',
  'assist.compose': 'app',
  'dashboard.toggle': 'view',
  copy: 'terminal',
  paste: 'terminal',
  find: 'terminal',
  'find.next': 'terminal',
  'find.previous': 'terminal',
  'block.selectPrev': 'terminal',
  'block.selectNext': 'terminal',
}

const GROUP_BY_PREFIX: Readonly<Record<string, CommandGroup>> = {
  workspace: 'workspace',
  window: 'workspace',
  tab: 'workspace',
  pane: 'pane',
  terminal: 'terminal',
  block: 'terminal',
  view: 'view',
  views: 'view',
  browser: 'browser',
  app: 'app',
  assistant: 'app',
  assist: 'app',
  agent: 'app',
  workflows: 'app',
  developer: 'app',
  editor: 'app',
}

export function commandGroup(id: string, category?: string | null): CommandGroup {
  const known = GROUP_BY_ID[id]
  if (known) return known
  const prefix = id.split('.')[0]
  if (Object.hasOwn(GROUP_BY_PREFIX, prefix)) return GROUP_BY_PREFIX[prefix]
  const cat = category?.toLowerCase()
  if (cat && Object.hasOwn(GROUP_BY_PREFIX, cat)) return GROUP_BY_PREFIX[cat]
  return 'other'
}

export function groupRows<T extends { group: CommandGroup }>(
  rows: readonly T[],
): { group: CommandGroup; rows: T[] }[] {
  return COMMAND_GROUPS.map((group) => ({
    group,
    rows: rows.filter((r) => r.group === group),
  })).filter((g) => g.rows.length > 0)
}
