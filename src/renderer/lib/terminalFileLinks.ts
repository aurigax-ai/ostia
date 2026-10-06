import type {
  IBufferCellPosition,
  IBufferRange,
  ILink,
  ILinkProvider,
  Terminal,
} from '@xterm/xterm'
import { LRUCache } from 'lru-cache'
import { findFileLinks, resolveLinkPath } from './fileLinks'

interface LogicalLine {
  text: string
  cells: IBufferCellPosition[]
}

const STAT_TTL_MS = 5_000
const STAT_CACHE_MAX = 500

export function readLogicalLine(term: Terminal, row: number): LogicalLine {
  const buffer = term.buffer.active
  let first = row - 1
  while (first > 0 && buffer.getLine(first)?.isWrapped) first--
  let text = ''
  const cells: IBufferCellPosition[] = []
  for (let y = first; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line || (y > first && !line.isWrapped)) break
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (let i = 0; i < chars.length; i++) cells.push({ x: x + 1, y: y + 1 })
      text += chars
    }
  }
  return { text, cells }
}

export interface FileLinkDeps {
  cwd: () => string | null
  remote: () => boolean
  stat: (path: string) => Promise<'file' | 'dir' | null>
  open: (path: string, line?: number, column?: number) => void
  modifierHeld: (event: MouseEvent) => boolean
  hover: (range: IBufferRange) => void
  leave: () => void
}

export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  const cache = new LRUCache<string, Promise<'file' | 'dir' | null>>({
    ttl: STAT_TTL_MS,
    max: STAT_CACHE_MAX,
  })
  const statCached = (path: string): Promise<'file' | 'dir' | null> => {
    const hit = cache.get(path)
    if (hit) return hit
    const kind = deps.stat(path).catch(() => null)
    cache.set(path, kind)
    return kind
  }

  return {
    provideLinks(row, callback) {
      if (deps.remote()) {
        callback(undefined)
        return
      }
      const cwd = deps.cwd()
      const { text, cells } = readLogicalLine(term, row)
      const matches = findFileLinks(text).filter((m) => {
        const start = cells[m.start]
        const end = cells[m.end - 1]
        return start && end && start.y <= row && end.y >= row
      })
      if (matches.length === 0) {
        callback(undefined)
        return
      }
      void Promise.all(
        matches.map(async (m): Promise<ILink | null> => {
          const path = resolveLinkPath(m.path, cwd ?? '~')
          if ((await statCached(path)) !== 'file') return null
          return {
            range: { start: cells[m.start], end: cells[m.end - 1] },
            text: text.slice(m.start, m.end),
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              if (deps.modifierHeld(event)) deps.open(path, m.line, m.column)
            },
            hover: () => deps.hover({ start: cells[m.start], end: cells[m.end - 1] }),
            leave: () => deps.leave(),
          }
        }),
      ).then((links) => {
        const found = links.filter((l): l is ILink => l !== null)
        callback(found.length > 0 ? found : undefined)
      })
    },
  }
}
