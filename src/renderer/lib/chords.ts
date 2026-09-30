export type AppChord =
  | 'palette.toggle'
  | 'view.toggleRail'
  | 'app.openSettings'
  | 'attention.jumpToLatest'
  | 'history.search'
  | 'workspace.new'
  | 'agent.resume'
  | 'workspace.goto'
  | 'selection.sendToAgent'
  | 'view.zoomIn'
  | 'view.zoomOut'
  | 'view.zoomReset'

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
  '=': 'view.zoomIn',
  '-': 'view.zoomOut',
  '0': 'view.zoomReset',
  c: 'copy',
  v: 'paste',
  f: 'find',
  arrowup: 'block.selectPrev',
  arrowdown: 'block.selectNext',
}

const MAC_SHIFT: Record<string, Chord> = {
  e: 'selection.sendToAgent',
  r: 'agent.resume',
  u: 'attention.jumpToLatest',
  h: 'history.search',
  '+': 'view.zoomIn',
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
  e: 'selection.sendToAgent',
  '+': 'view.zoomIn',
  arrowup: 'block.selectPrev',
  arrowdown: 'block.selectNext',
}

const CTRL: Record<string, Chord> = {
  ',': 'app.openSettings',
  '=': 'view.zoomIn',
  '-': 'view.zoomOut',
  '0': 'view.zoomReset',
}

export function workspaceDigit(key: string): number | null {
  return /^[1-9]$/.test(key) ? Number(key) - 1 : null
}

export function matchChord(e: KeyLike, mac: boolean): Chord | null {
  if (e.altKey) return null
  const key = e.key.toLowerCase()
  if (mac) {
    if (!e.metaKey || e.ctrlKey) return null
    if (!e.shiftKey && workspaceDigit(key) !== null) return 'workspace.goto'
    return (e.shiftKey ? MAC_SHIFT[key] : MAC[key]) ?? null
  }
  if (!e.ctrlKey || e.metaKey) return null
  if (!e.shiftKey && workspaceDigit(key) !== null) return 'workspace.goto'
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
  'workspace.goto',
  'selection.sendToAgent',
  'view.zoomIn',
  'view.zoomOut',
  'view.zoomReset',
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
  'workspace.goto': ['⌘1-9', 'Ctrl+1-9'],
  'selection.sendToAgent': ['⌘⇧E', 'Ctrl+Shift+E'],
  'view.zoomIn': ['⌘=', 'Ctrl+='],
  'view.zoomOut': ['⌘-', 'Ctrl+-'],
  'view.zoomReset': ['⌘0', 'Ctrl+0'],
  copy: ['⌘C', 'Ctrl+Shift+C'],
  paste: ['⌘V', 'Ctrl+Shift+V'],
  find: ['⌘F', 'Ctrl+Shift+F'],
}

export function chordLabel(chord: Chord, mac: boolean): string {
  return LABELS[chord][mac ? 0 : 1]
}
