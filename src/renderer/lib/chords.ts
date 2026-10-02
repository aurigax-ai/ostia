import {
  type ChordProblem,
  type ChordSpec,
  DIGIT_RANGE,
  type KeyLike,
  type KeybindingMap,
  chordText,
  formatChord,
  overlaps,
  parseChord,
  specFromEvent,
  stealsTerminalKey,
} from '@shared/chordSpec'
import { isDangerousSegment } from '@shared/protoGuard'
import { commands } from '../commands/registry'
import { useSettingsStore } from '../stores/settingsStore'

export type { KeyLike, KeybindingMap } from '@shared/chordSpec'

export type AppChord =
  | 'palette.toggle'
  | 'view.toggleRail'
  | 'app.openSettings'
  | 'attention.jumpToLatest'
  | 'history.search'
  | 'workflows.search'
  | 'workspace.new'
  | 'agent.resume'
  | 'workspace.goto'
  | 'selection.sendToAgent'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'
  | 'assist.compose'
  | 'dashboard.toggle'
  | 'pane.splitRight'
  | 'pane.splitDown'
  | 'pane.focusLeft'
  | 'pane.focusRight'
  | 'pane.focusUp'
  | 'pane.focusDown'
  | 'pane.zoom'
  | 'pane.close'
  | 'workspace.next'
  | 'workspace.previous'

export type TerminalChord = 'copy' | 'paste' | 'find' | 'block.selectPrev' | 'block.selectNext'

export const WORKSPACE_GOTO = 'workspace.goto'

export const TERMINAL_CHORDS: readonly TerminalChord[] = [
  'copy',
  'paste',
  'find',
  'block.selectPrev',
  'block.selectNext',
]

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_CHORDS)

export const DEFAULT_CHORDS: Readonly<
  Record<AppChord | TerminalChord, [mac: string, other: string]>
> = {
  'palette.toggle': ['Cmd+K', 'Ctrl+Shift+P'],
  'view.toggleRail': ['Cmd+\\', 'Ctrl+Shift+B'],
  'app.openSettings': ['Cmd+,', 'Ctrl+,'],
  'attention.jumpToLatest': ['Cmd+Shift+U', 'Ctrl+Shift+U'],
  'history.search': ['Cmd+Shift+H', 'Ctrl+Shift+H'],
  'workflows.search': ['Cmd+Shift+S', 'Ctrl+Shift+S'],
  'workspace.new': ['Cmd+T', 'Ctrl+Shift+T'],
  'agent.resume': ['Cmd+Shift+R', 'Ctrl+Shift+R'],
  'workspace.goto': [`Cmd+${DIGIT_RANGE}`, `Ctrl+${DIGIT_RANGE}`],
  'selection.sendToAgent': ['Cmd+Shift+E', 'Ctrl+Shift+E'],
  'view.zoomIn': ['Cmd+=', 'Ctrl+='],
  'view.zoomOut': ['Cmd+-', 'Ctrl+Shift+-'],
  'view.zoomReset': ['Cmd+0', 'Ctrl+0'],
  'assist.compose': ['Cmd+J', 'Ctrl+Shift+J'],
  'dashboard.toggle': ['Cmd+Shift+D', 'Ctrl+Shift+D'],
  'pane.splitRight': ['Cmd+Alt+\\', 'Ctrl+Alt+\\'],
  'pane.splitDown': ['Cmd+Alt+-', 'Ctrl+Alt+-'],
  'pane.focusLeft': ['Cmd+Ctrl+Left', 'Ctrl+Shift+Alt+H'],
  'pane.focusRight': ['Cmd+Ctrl+Right', 'Ctrl+Shift+Alt+L'],
  'pane.focusUp': ['Cmd+Ctrl+Up', 'Ctrl+Shift+Alt+K'],
  'pane.focusDown': ['Cmd+Ctrl+Down', 'Ctrl+Shift+Alt+J'],
  'pane.zoom': ['Cmd+Shift+X', 'Ctrl+Shift+X'],
  'pane.close': ['Cmd+Shift+W', 'Ctrl+Shift+W'],
  'workspace.next': ['Cmd+Ctrl+]', 'Ctrl+Shift+PageDown'],
  'workspace.previous': ['Cmd+Ctrl+[', 'Ctrl+Shift+PageUp'],
  copy: ['Cmd+C', 'Ctrl+Shift+C'],
  paste: ['Cmd+V', 'Ctrl+Shift+V'],
  find: ['Cmd+F', 'Ctrl+Shift+F'],
  'block.selectPrev': ['Cmd+Up', 'Ctrl+Shift+Up'],
  'block.selectNext': ['Cmd+Down', 'Ctrl+Shift+Down'],
}

export function defaultChord(id: string, mac: boolean): ChordSpec | null {
  const pair = (DEFAULT_CHORDS as Record<string, [string, string]>)[id]
  return pair ? parseChord(pair[mac ? 0 : 1], mac) : null
}

export function bindingProblem(id: string, spec: ChordSpec, mac: boolean): ChordProblem | null {
  const steal = stealsTerminalKey(spec, mac)
  if (steal) return steal
  const isRange = spec.key === DIGIT_RANGE
  return isRange === (id === WORKSPACE_GOTO) ? null : 'digit-range'
}

export function checkBinding(id: string, text: string, mac: boolean): ChordProblem | null {
  const spec = parseChord(text, mac)
  return spec ? bindingProblem(id, spec, mac) : 'invalid'
}

export interface BindingTable {
  byId: ReadonlyMap<string, ChordSpec>
  bySignature: ReadonlyMap<string, string>
}

export function effectiveBindings(user: KeybindingMap, mac: boolean): BindingTable {
  const byId = new Map<string, ChordSpec>()
  for (const id of Object.keys(DEFAULT_CHORDS)) {
    const spec = defaultChord(id, mac)
    if (spec) byId.set(id, spec)
  }
  const overridden: string[] = []
  for (const [id, value] of Object.entries(user)) {
    if (value === null) {
      byId.delete(id)
      continue
    }
    const spec = parseChord(value, mac)
    if (!spec || bindingProblem(id, spec, mac)) continue
    byId.set(id, spec)
    overridden.push(id)
  }
  const bySignature = new Map<string, string>()
  const index = (id: string): void => {
    const spec = byId.get(id)
    if (spec) bySignature.set(formatChord(spec, mac), id)
  }
  for (const id of byId.keys()) if (!overridden.includes(id)) index(id)
  for (const id of overridden) index(id)
  return { byId, bySignature }
}

let cache: { user: KeybindingMap; mac: boolean; table: BindingTable } | null = null

export function currentBindings(mac: boolean): BindingTable {
  const user = useSettingsStore.getState().keybindings
  if (cache?.user !== user || cache.mac !== mac) {
    cache = { user, mac, table: effectiveBindings(user, mac) }
  }
  return cache.table
}

export function workspaceDigit(key: string): number | null {
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null
}

export function workspaceIndex(e: KeyLike): number | null {
  const spec = specFromEvent(e)
  return spec ? workspaceDigit(spec.key) : null
}

export function matchChord(e: KeyLike, mac: boolean): string | null {
  const spec = specFromEvent(e)
  if (!spec) return null
  const { bySignature } = currentBindings(mac)
  const exact = bySignature.get(formatChord(spec, mac))
  if (exact) return exact
  if (workspaceDigit(spec.key) === null) return null
  return bySignature.get(formatChord({ ...spec, key: DIGIT_RANGE }, mac)) ?? null
}

export function isAppChord(chord: string | null): chord is string {
  return chord !== null && !TERMINAL_SET.has(chord)
}

export function chordOf(id: string, mac: boolean): ChordSpec | null {
  return currentBindings(mac).byId.get(id) ?? null
}

export function chordLabel(id: string, mac: boolean): string | null {
  const spec = chordOf(id, mac)
  return spec ? chordText(spec, mac) : null
}

export function useChordLabel(id: string, mac: boolean): string | null {
  useSettingsStore((s) => s.keybindings)
  return chordLabel(id, mac)
}

export function conflictsWith(id: string, spec: ChordSpec, mac: boolean): string[] {
  const out: string[] = []
  for (const [other, bound] of currentBindings(mac).byId) {
    if (other !== id && overlaps(bound, spec)) out.push(other)
  }
  return out
}

export function bindableIds(): string[] {
  const ids = new Set<string>(Object.keys(DEFAULT_CHORDS))
  for (const c of commands.describe()) if (!c.hidden) ids.add(c.id)
  return [...ids]
}

export function setKeybindingSetting(path: string, value: unknown, mac: boolean): void {
  const settings = useSettingsStore.getState()
  const id = path.split('.').slice(1).join('.')
  if (!id) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('keybindings must be an object of command id → chord string or null')
    }
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, chord] of entries) assertAgentBinding(key, chord, mac)
    settings.setKeybindings(Object.fromEntries(entries) as KeybindingMap)
    return
  }
  assertAgentBinding(id, value, mac)
  settings.setKeybinding(id, value as string | null)
}

const PROBLEM_TEXT: Record<ChordProblem, string> = {
  invalid: 'is not a chord like "Ctrl+Shift+K" or "Cmd+Alt+P"',
  escape: 'uses Escape, which belongs to the shell',
  tab: 'uses Tab, which belongs to the shell',
  bare: 'has no modifier, so it would steal a key the shell needs',
  'needs-modifier': 'needs Ctrl or Cmd; other modifiers belong to the shell',
  'ctrl-key': 'is a plain Ctrl key the shell uses',
  arrow: 'is a plain or Ctrl arrow the shell uses',
  'digit-range': 'must use 1-9 only for workspace.goto',
}

function assertAgentBinding(id: string, value: unknown, mac: boolean): void {
  if (!id || isDangerousSegment(id)) throw new Error(`invalid keybinding id: ${id}`)
  if (value === null) return
  if (typeof value !== 'string') {
    throw new Error(`keybindings.${id} must be a chord string or null`)
  }
  const problem = checkBinding(id, value, mac)
  if (problem) throw new Error(`keybindings.${id}: "${value}" ${PROBLEM_TEXT[problem]}`)
}
