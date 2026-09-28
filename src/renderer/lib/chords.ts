export type AppChord =
  | 'palette.toggle'
  | 'view.toggleRail'
  | 'app.openSettings'
  | 'attention.jumpToLatest'
  | 'history.search'
  | 'workspace.new'
  | 'agent.resume'

export type TerminalChord = 'copy' | 'paste' | 'find' | 'block.selectPrev' | 'block.selectNext'

export type Chord = AppChord | TerminalChord

export interface KeyLike {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  altKey: boolean
}

const MAC: Record<string, Chord> = {
  k: 'palette.toggle',
  t: 'workspace.new',
  '\\': 'view.toggleRail',
  ',': 'app.openSettings',
  c: 'copy',
  v: 'paste',
  f: 'find',
  arrowup: 'block.selectPrev',
  arrowdown: 'block.selectNext',
}

const MAC_SHIFT: Record<string, Chord> = {
  r: 'agent.resume',
  u: 'attention.jumpToLatest',
  h: 'history.search',
}

const CTRL_SHIFT: Record<string, Chord> = {
  p: 'palette.toggle',
  u: 'attention.jumpToLatest',
  b: 'view.toggleRail',
  c: 'copy',
  v: 'paste',
  f: 'find',
  h: 'history.search',
  t: 'workspace.new',
  r: 'agent.resume',
  arrowup: 'block.selectPrev',
  arrowdown: 'block.selectNext',
}

const CTRL: Record<string, Chord> = {
  ',': 'app.openSettings',
}

export function matchChord(e: KeyLike, mac: boolean): Chord | null {
  if (e.altKey) return null
  const key = e.key.toLowerCase()
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return null
    return (e.shiftKey ? MAC_SHIFT[key] : MAC[key]) ?? null
  }
  if (!e.ctrlKey || e.metaKey) return null
  return (e.shiftKey ? CTRL_SHIFT[key] : CTRL[key]) ?? null
}

const APP_CHORDS: ReadonlySet<Chord> = new Set<AppChord>([
  'palette.toggle',
  'view.toggleRail',
  'app.openSettings',
  'attention.jumpToLatest',
  'history.search',
  'workspace.new',
  'agent.resume',
])

export function isAppChord(chord: Chord | null): chord is AppChord {
  return chord !== null && APP_CHORDS.has(chord)
}

const LABELS: Record<Chord, [mac: string, other: string]> = {
  'palette.toggle': ['⌘K', 'Ctrl+Shift+P'],
  'view.toggleRail': ['⌘\\', 'Ctrl+Shift+B'],
  'app.openSettings': ['⌘,', 'Ctrl+,'],
  'attention.jumpToLatest': ['⌘⇧U', 'Ctrl+Shift+U'],
  'block.selectPrev': ['⌘↑', 'Ctrl+Shift+↑'],
  'block.selectNext': ['⌘↓', 'Ctrl+Shift+↓'],
  'history.search': ['⌘⇧H', 'Ctrl+Shift+H'],
  'workspace.new': ['⌘T', 'Ctrl+Shift+T'],
  'agent.resume': ['⌘⇧R', 'Ctrl+Shift+R'],
  copy: ['⌘C', 'Ctrl+Shift+C'],
  paste: ['⌘V', 'Ctrl+Shift+V'],
  find: ['⌘F', 'Ctrl+Shift+F'],
}

export function chordLabel(chord: Chord, mac: boolean): string {
  return LABELS[chord][mac ? 0 : 1]
}
