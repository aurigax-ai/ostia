import type { PtyEntry } from './ptyRegistry'

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
  for (const wc of entry.subs.values()) {
    if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows)
  }
}
