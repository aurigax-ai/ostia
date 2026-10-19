import type { PtyEntry } from './ptyRegistry'

interface Size {
  cols: number
  rows: number
}

interface PaneSizes {
  desktop: Size | null
  phoneHolder: string | null
}

const sizes = new WeakMap<PtyEntry, PaneSizes>()

function sizesOf(entry: PtyEntry): PaneSizes {
  let found = sizes.get(entry)
  if (!found) {
    found = { desktop: null, phoneHolder: null }
    sizes.set(entry, found)
  }
  return found
}

function resizePty(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const c = cols || 80
  const r = rows || 24
  try {
    entry.pty.resize(c, r)
  } catch {
    return
  }
  entry.mirror.resize(c, r)
}

export function resizeForAll(paneId: string, entry: PtyEntry, cols: number, rows: number): void {
  if (entry.pty.cols === cols && entry.pty.rows === rows) return
  resizePty(entry, cols, rows)
  for (const wc of entry.subs.values()) {
    if (!wc.isDestroyed()) wc.send(`pty:size:${paneId}`, cols, rows)
  }
}

export function resizeFromDesktop(entry: PtyEntry | undefined, cols: number, rows: number): void {
  if (!entry) return
  const known = sizesOf(entry)
  if (cols > 0 && rows > 0) known.desktop = { cols, rows }
  known.phoneHolder = null
  resizePty(entry, cols, rows)
}

export function resizeFromPhone(
  paneId: string,
  entry: PtyEntry,
  holder: string,
  cols: number,
  rows: number,
): void {
  sizesOf(entry).phoneHolder = holder
  resizeForAll(paneId, entry, cols, rows)
}

export function phoneOwnerAttached(entry: PtyEntry): void {
  const known = sizesOf(entry)
  known.desktop ??= { cols: entry.pty.cols, rows: entry.pty.rows }
}

export function phoneOwnerDetached(paneId: string, entry: PtyEntry, holder: string): void {
  const known = sizesOf(entry)
  if (known.phoneHolder !== holder) return
  known.phoneHolder = null
  if (known.desktop) resizeForAll(paneId, entry, known.desktop.cols, known.desktop.rows)
}
