import {
  BROWSER_CHORD_IDS,
  CHORDS_PER_COMMAND_MAX,
  type ChordProblem,
  type ChordSpec,
  type ChordValue,
  DIGIT_RANGE,
  type KeyLike,
  type KeybindingMap,
  WORKSPACE_GOTO,
  bindingProblem,
  checkBinding,
  chordText,
  chordTexts,
  formatChord,
  formatScopedChord,
  overlaps,
  parseScopedChord,
  sameChord,
  sameScope,
  specFromEvent,
} from '@shared/chordSpec'
import { isDangerousSegment } from '@shared/protoGuard'
import { commands } from '../commands/registry'
import { useKeymapStore } from '../stores/keymapStore'
import { useSettingsStore } from '../stores/settingsStore'

export type { KeyLike, KeybindingMap } from '@shared/chordSpec'
export { WORKSPACE_GOTO, bindingProblem, checkBinding } from '@shared/chordSpec'

export type AppChord =
  | 'palette.toggle'
  | 'view.toggleRail'
  | 'app.openSettings'
  | 'attention.jumpToLatest'
  | 'history.search'
  | 'workflows.search'
  | 'workspace.new'
  | 'window.new'
  | 'tab.new'
  | 'terminal.clear'
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
  | 'tab.next'
  | 'tab.previous'
  | 'workspace.next'
  | 'workspace.previous'

export const TERMINAL_COMMAND_CHORDS = [
  'terminal.scrollToTop',
  'terminal.scrollToBottom',
  'terminal.scrollPageUp',
  'terminal.scrollPageDown',
  'terminal.scrollLineUp',
  'terminal.scrollLineDown',
  'tab.moveLeft',
  'tab.moveRight',
] as const

export type TerminalCommandChord = (typeof TERMINAL_COMMAND_CHORDS)[number]

export type TerminalChord =
  | 'copy'
  | 'paste'
  | 'find'
  | 'block.selectPrev'
  | 'block.selectNext'
  | TerminalCommandChord

export type BrowserChord = (typeof BROWSER_CHORD_IDS)[number]

export const TERMINAL_CHORDS: readonly TerminalChord[] = [
  'copy',
  'paste',
  'find',
  'block.selectPrev',
  'block.selectNext',
  ...TERMINAL_COMMAND_CHORDS,
]

const TERMINAL_SET: ReadonlySet<string> = new Set(TERMINAL_CHORDS)

const TERMINAL_COMMAND_SET: ReadonlySet<string> = new Set(TERMINAL_COMMAND_CHORDS)

export const BROWSER_CHORDS: readonly BrowserChord[] = BROWSER_CHORD_IDS

const BROWSER_SET: ReadonlySet<string> = new Set(BROWSER_CHORDS)

export const DEFAULT_CHORDS: Readonly<
  Record<AppChord | TerminalChord | BrowserChord, [mac: ChordValue, other: ChordValue]>
> = {
  'palette.toggle': [['Shift+Cmd+P', 'Cmd+K'], 'Ctrl+Shift+P'],
  'view.toggleRail': [['Cmd+B', 'Cmd+\\'], 'Ctrl+Shift+B'],
  'app.openSettings': ['Cmd+,', 'Ctrl+,'],
  'attention.jumpToLatest': ['Cmd+Shift+U', 'Ctrl+Shift+U'],
  'history.search': ['Cmd+Shift+H', 'Ctrl+Shift+H'],
  'workflows.search': ['Cmd+Shift+S', 'Ctrl+Shift+S'],
  'workspace.new': ['Cmd+N', 'Ctrl+Shift+N'],
  'window.new': ['Cmd+Shift+N', 'Ctrl+Shift+Alt+N'],
  'tab.new': ['Cmd+T', 'Ctrl+Shift+T'],
  'terminal.clear': ['terminal:Cmd+K', 'terminal:Ctrl+Shift+K'],
  'agent.resume': ['Cmd+Shift+R', 'Ctrl+Shift+R'],
  'workspace.goto': [`Cmd+${DIGIT_RANGE}`, `Ctrl+${DIGIT_RANGE}`],
  'selection.sendToAgent': ['Cmd+Shift+E', 'Ctrl+Shift+E'],
  'view.zoomIn': [['Cmd+=', 'Shift+Cmd+='], 'Ctrl+='],
  'view.zoomOut': ['Cmd+-', 'Ctrl+Shift+-'],
  'view.zoomReset': ['Cmd+0', 'Ctrl+0'],
  'assist.compose': ['Cmd+J', 'Ctrl+Shift+J'],
  'dashboard.toggle': [['Cmd+Alt+D', 'Cmd+Shift+D'], 'Ctrl+Shift+D'],
  'pane.splitRight': [['terminal:Cmd+D', 'Cmd+Alt+\\'], 'Ctrl+Alt+\\'],
  'pane.splitDown': [['terminal:Shift+Cmd+D', 'Cmd+Alt+-'], 'Ctrl+Alt+-'],
  'pane.focusLeft': [['terminal:Cmd+Alt+Left', 'Cmd+Ctrl+Left'], 'Ctrl+Shift+Alt+H'],
  'pane.focusRight': [['terminal:Cmd+Alt+Right', 'Cmd+Ctrl+Right'], 'Ctrl+Shift+Alt+L'],
  'pane.focusUp': [['terminal:Cmd+Alt+Up', 'Cmd+Ctrl+Up'], 'Ctrl+Shift+Alt+K'],
  'pane.focusDown': [['terminal:Cmd+Alt+Down', 'Cmd+Ctrl+Down'], 'Ctrl+Shift+Alt+J'],
  'pane.zoom': [
    ['terminal:Shift+Cmd+Enter', 'Cmd+Shift+X'],
    ['terminal:Ctrl+Shift+Enter', 'Ctrl+Shift+X'],
  ],
  'pane.close': ['Cmd+W', 'Ctrl+Shift+W'],
  'tab.next': [['Ctrl+Tab', 'Shift+Cmd+]'], 'Ctrl+Tab'],
  'tab.previous': [['Ctrl+Shift+Tab', 'Shift+Cmd+['], 'Ctrl+Shift+Tab'],
  'workspace.next': ['Cmd+Ctrl+]', 'Ctrl+Shift+PageDown'],
  'workspace.previous': ['Cmd+Ctrl+[', 'Ctrl+Shift+PageUp'],
  copy: ['Cmd+C', 'Ctrl+Shift+C'],
  paste: ['Cmd+V', 'Ctrl+Shift+V'],
  find: ['Cmd+F', 'Ctrl+Shift+F'],
  'block.selectPrev': ['Cmd+Up', 'Ctrl+Shift+Up'],
  'block.selectNext': ['Cmd+Down', 'Ctrl+Shift+Down'],
  'terminal.scrollToTop': ['Cmd+Home', ''],
  'terminal.scrollToBottom': ['Cmd+End', ''],
  'terminal.scrollPageUp': ['Cmd+PageUp', ''],
  'terminal.scrollPageDown': ['Cmd+PageDown', ''],
  'terminal.scrollLineUp': ['', ''],
  'terminal.scrollLineDown': ['', ''],
  'tab.moveLeft': ['Shift+Cmd+Left', ''],
  'tab.moveRight': ['Shift+Cmd+Right', ''],
  'browser.focusAddress': ['Cmd+L', 'Ctrl+Shift+L'],
  'browser.reload': ['Cmd+R', 'Ctrl+F5'],
  'browser.back': ['Cmd+[', 'Alt+Left'],
  'browser.forward': ['Cmd+]', 'Alt+Right'],
}

function specsOf(value: ChordValue, mac: boolean, id?: string): ChordSpec[] {
  const out: ChordSpec[] = []
  for (const text of chordTexts(value)) {
    const spec = parseScopedChord(text, mac)
    if (!spec || (id !== undefined && bindingProblem(id, spec, mac))) continue
    if (!out.some((s) => sameChord(s, spec) && sameScope(s, spec))) out.push(spec)
  }
  return out
}

export function defaultChords(id: string, mac: boolean): ChordSpec[] {
  const pair = (DEFAULT_CHORDS as Record<string, [ChordValue, ChordValue]>)[id]
  return pair ? specsOf(pair[mac ? 0 : 1], mac) : []
}

export function defaultChord(id: string, mac: boolean): ChordSpec | null {
  return defaultChords(id, mac)[0] ?? null
}

export interface BindingTable {
  byId: ReadonlyMap<string, readonly ChordSpec[]>
  bySignature: ReadonlyMap<string, string>
  terminalBySignature: ReadonlyMap<string, string>
}

const NO_KEYMAP: KeybindingMap = Object.freeze(Object.create(null))

function applyLayer(byId: Map<string, ChordSpec[]>, layer: KeybindingMap, mac: boolean): string[] {
  const bound: string[] = []
  for (const [id, value] of Object.entries(layer)) {
    if (value === null) {
      byId.delete(id)
      continue
    }
    const specs = specsOf(value, mac, id)
    if (specs.length === 0) continue
    byId.set(id, specs)
    bound.push(id)
  }
  return bound
}

export function effectiveBindings(
  user: KeybindingMap,
  mac: boolean,
  keymap: KeybindingMap = NO_KEYMAP,
): BindingTable {
  const byId = new Map<string, ChordSpec[]>()
  for (const id of Object.keys(DEFAULT_CHORDS)) {
    const specs = defaultChords(id, mac)
    if (specs.length > 0) byId.set(id, specs)
  }
  const fromKeymap = applyLayer(byId, keymap, mac)
  const fromUser = applyLayer(byId, user, mac)
  const layered = new Set([...fromKeymap, ...fromUser])
  const bySignature = new Map<string, string>()
  const terminalBySignature = new Map<string, string>()
  const index = (id: string): void => {
    for (const spec of byId.get(id) ?? []) {
      const target = spec.terminal ? terminalBySignature : bySignature
      target.set(formatChord(spec, mac), id)
    }
  }
  for (const id of byId.keys()) if (!layered.has(id)) index(id)
  for (const id of fromKeymap) if (!fromUser.includes(id)) index(id)
  for (const id of fromUser) index(id)
  return { byId, bySignature, terminalBySignature }
}

export function keymapBindings(): KeybindingMap {
  return useKeymapStore.getState().loaded?.bindings ?? NO_KEYMAP
}

let cache: {
  user: KeybindingMap
  keymap: KeybindingMap
  mac: boolean
  table: BindingTable
} | null = null

export function currentBindings(mac: boolean): BindingTable {
  const user = useSettingsStore.getState().keybindings
  const keymap = keymapBindings()
  if (cache?.user !== user || cache.keymap !== keymap || cache.mac !== mac) {
    cache = { user, keymap, mac, table: effectiveBindings(user, mac, keymap) }
  }
  return cache.table
}

export function baseChords(id: string, mac: boolean): readonly ChordSpec[] {
  return effectiveBindings(NO_KEYMAP, mac, keymapBindings()).byId.get(id) ?? []
}

export function baseChord(id: string, mac: boolean): ChordSpec | null {
  return baseChords(id, mac)[0] ?? null
}

export function useBindings(): void {
  useSettingsStore((s) => s.keybindings)
  useKeymapStore((s) => s.loaded)
}

export function onBindingsChange(cb: () => void): () => void {
  const offSettings = useSettingsStore.subscribe((s, prev) => {
    if (s.keybindings !== prev.keybindings) cb()
  })
  const offKeymap = useKeymapStore.subscribe((s, prev) => {
    if (s.loaded !== prev.loaded) cb()
  })
  return () => {
    offSettings()
    offKeymap()
  }
}

export function workspaceDigit(key: string): number | null {
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null
}

export function workspaceIndex(e: KeyLike): number | null {
  const spec = specFromEvent(e)
  return spec ? workspaceDigit(spec.key) : null
}

function lookup(signatures: ReadonlyMap<string, string>, spec: ChordSpec, mac: boolean) {
  const exact = signatures.get(formatChord(spec, mac))
  if (exact) return exact
  if (workspaceDigit(spec.key) === null) return null
  return signatures.get(formatChord({ ...spec, key: DIGIT_RANGE }, mac)) ?? null
}

export function matchChord(e: KeyLike, mac: boolean): string | null {
  const spec = specFromEvent(e)
  return spec ? lookup(currentBindings(mac).bySignature, spec, mac) : null
}

export function matchTerminalChord(e: KeyLike, mac: boolean): string | null {
  const spec = specFromEvent(e)
  return spec ? lookup(currentBindings(mac).terminalBySignature, spec, mac) : null
}

export function matchChordInTerminal(e: KeyLike, mac: boolean): string | null {
  return matchTerminalChord(e, mac) ?? matchChord(e, mac)
}

export function isAppChord(chord: string | null): chord is string {
  return chord !== null && !TERMINAL_SET.has(chord) && !BROWSER_SET.has(chord)
}

export function isTerminalCommandChord(chord: string | null): chord is TerminalCommandChord {
  return chord !== null && TERMINAL_COMMAND_SET.has(chord)
}

export function isBrowserChord(chord: string | null): chord is BrowserChord {
  return chord !== null && BROWSER_SET.has(chord)
}

export function execChord(chord: string, e: KeyLike): void {
  if (chord === WORKSPACE_GOTO) void commands.exec(chord, { index: workspaceIndex(e) })
  else void commands.exec(chord)
}

export function runAppChord(e: KeyLike & { preventDefault: () => void }, mac: boolean): boolean {
  const chord = matchChord(e, mac)
  if (!isAppChord(chord)) return false
  e.preventDefault()
  execChord(chord, e)
  return true
}

export function chordsOf(id: string, mac: boolean): readonly ChordSpec[] {
  return currentBindings(mac).byId.get(id) ?? []
}

export function chordOf(id: string, mac: boolean): ChordSpec | null {
  const specs = chordsOf(id, mac)
  return specs.find((spec) => !spec.terminal) ?? specs[0] ?? null
}

export function chordLabel(id: string, mac: boolean): string | null {
  const spec = chordOf(id, mac)
  return spec ? chordText(spec, mac) : null
}

export function useChordLabel(id: string, mac: boolean): string | null {
  useBindings()
  return chordLabel(id, mac)
}

export function conflictsWith(id: string, spec: ChordSpec, mac: boolean): string[] {
  const out: string[] = []
  for (const [other, bound] of currentBindings(mac).byId) {
    if (other !== id && bound.some((b) => overlaps(b, spec) && sameScope(b, spec))) out.push(other)
  }
  return out
}

export function chordsWithout(id: string, spec: ChordSpec, mac: boolean): string[] {
  return chordsOf(id, mac)
    .filter((bound) => !(overlaps(bound, spec) && sameScope(bound, spec)))
    .map((bound) => formatScopedChord(bound, mac))
}

export function chordsWithoutKey(id: string, spec: ChordSpec, mac: boolean): string[] {
  return chordsOf(id, mac)
    .filter((bound) => !overlaps(bound, spec))
    .map((bound) => formatScopedChord(bound, mac))
}

export function terminalKeyConflicts(spec: ChordSpec, mac: boolean): string[] {
  const inTerminal = conflictsWith('', { ...spec, terminal: true }, mac)
  const everywhere = conflictsWith('', { ...spec, terminal: false }, mac)
  return [...new Set([...inTerminal, ...everywhere])].filter((id) => !isBrowserChord(id))
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
      throw new Error('keybindings must be an object of command id → chords or null')
    }
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, chord] of entries) assertAgentBinding(key, chord, mac)
    settings.setKeybindings(Object.fromEntries(entries) as KeybindingMap)
    return
  }
  assertAgentBinding(id, value, mac)
  settings.setKeybinding(id, value as ChordValue | null)
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
  const list = Array.isArray(value)
  const texts: unknown[] = list ? value : [value]
  if (texts.length === 0 || texts.length > CHORDS_PER_COMMAND_MAX) {
    throw new Error(`keybindings.${id} must list 1 to ${CHORDS_PER_COMMAND_MAX} chords`)
  }
  for (const text of texts) {
    if (typeof text !== 'string') {
      throw new Error(`keybindings.${id} must be a chord string, a list of them or null`)
    }
    const problem = checkBinding(id, text, mac)
    if (problem) throw new Error(`keybindings.${id}: "${text}" ${PROBLEM_TEXT[problem]}`)
  }
}
