import type { PtyEntry } from './ptyRegistry'

export interface PtyHold {
  holder: string
  desktop: { cols: number; rows: number }
}

export type HoldOutcome = 'ok' | 'held-by-other'

function tellWindows(
  paneId: string,
  entry: PtyEntry,
  cols: number,
  rows: number,
  held: boolean,
): void {
  for (const wc of entry.subs.values()) {
    if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows, held)
  }
}

export function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const c = cols || 80
  const r = rows || 24
  const changed = entry.pty.cols !== c || entry.pty.rows !== r
  try {
    entry.pty.resize(c, r)
  } catch {
    return
  }
  entry.mirror.resize(c, r)
  if (changed) for (const listener of entry.sizeListeners) listener(c, r)
}

export function resizeForAll(paneId: string, entry: PtyEntry, cols: number, rows: number): void {
  if (entry.pty.cols === cols && entry.pty.rows === rows) return
  resizePty(entry, cols, rows)
  tellWindows(paneId, entry, cols, rows, entry.hold !== null)
}

export function holdPty(
  paneId: string,
  entry: PtyEntry,
  holder: string,
  cols: number,
  rows: number,
): HoldOutcome {
  if (entry.hold && entry.hold.holder !== holder) return 'held-by-other'
  entry.hold ??= { holder, desktop: { cols: entry.pty.cols, rows: entry.pty.rows } }
  resizePty(entry, cols, rows)
  tellWindows(paneId, entry, cols, rows, true)
  return 'ok'
}

export function releasePty(paneId: string, entry: PtyEntry, holder?: string): void {
  const hold = entry.hold
  if (!hold || (holder !== undefined && hold.holder !== holder)) return
  entry.hold = null
  resizePty(entry, hold.desktop.cols, hold.desktop.rows)
  tellWindows(paneId, entry, hold.desktop.cols, hold.desktop.rows, false)
}

export function resizeFromDesktop(
  paneId: string,
  entry: PtyEntry,
  cols: number,
  rows: number,
): void {
  const held = entry.hold !== null
  entry.hold = null
  resizePty(entry, cols, rows)
  if (held) tellWindows(paneId, entry, cols || 80, rows || 24, false)
}
