import { findFileLinks, resolveLinkPath } from '@shared/files/fileLinks'
import type { IBufferCellPosition, IBufferRange, ILink, ILinkProvider } from '@xterm/xterm'
import { LRUCache } from 'lru-cache'
import type { OstiaTerminal as Terminal } from '@/lib/terminal/ostiaTerminal'
import type { PathLinkTarget } from './linkModifier'

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

export function matchesOnRow<T extends { start: number; end: number }>(
  matches: T[],
  cells: IBufferCellPosition[],
  row: number,
): T[] {
  return matches.filter((m) => {
    const start = cells[m.start]
    const end = cells[m.end - 1]
    return start && end && start.y <= row && end.y >= row
  })
}

export function provideFound(
  pending: Promise<ILink | null>[],
  callback: (links: ILink[] | undefined) => void,
): void {
  void Promise.all(pending).then((links) => {
    const found = links.filter((l): l is ILink => l !== null)
    callback(found.length > 0 ? found : undefined)
  })
}

type Kind = 'file' | 'dir'

export type FileLinkAction = 'open-file' | 'admit-file' | 'reveal-folder' | 'open-folder'

export interface FileLinkFacts {
  confined: Kind | null
  probed: Kind | null
  revealable: boolean
  confinedOnly: boolean
}

export function fileLinkAction(facts: FileLinkFacts): FileLinkAction | null {
  if (facts.confined === 'file') return 'open-file'
  if (facts.confined === 'dir' && facts.revealable) return 'reveal-folder'
  if (facts.confinedOnly) return null
  if (facts.confined === 'dir' || facts.probed === 'dir') return 'open-folder'
  return facts.probed === 'file' ? 'admit-file' : null
}

function needsHumanClick(how: PathLinkTarget, action: FileLinkAction): boolean {
  if (how !== 'open') return how !== 'show'
  return action === 'admit-file' || action === 'open-folder'
}

export function pathLinkOffers(
  action: FileLinkAction,
  facts: Pick<FileLinkFacts, 'confined' | 'confinedOnly'>,
  inTree: boolean,
): PathLinkTarget[] {
  const offers: PathLinkTarget[] = ['open']
  if (!facts.confinedOnly && action !== 'open-folder') offers.push('open-system')
  if (facts.confined && inTree && action !== 'reveal-folder') offers.push('show')
  if (!facts.confinedOnly) offers.push('show-system')
  return offers
}

export interface FileLinkTarget {
  written: string
  path: string
  line?: number
  column?: number
}

export interface FileLinkDeps {
  cwd: () => string | null
  remote: () => boolean
  confinedOnly: () => boolean
  revealable: (path: string) => boolean
  stat: (path: string) => Promise<Kind | null>
  probe: (written: string) => Promise<Kind | null>
  activate: (how: PathLinkTarget, action: FileLinkAction, target: FileLinkTarget) => void
  target: (event: MouseEvent) => PathLinkTarget | null
  hover: (range: IBufferRange, action: FileLinkAction, offers: PathLinkTarget[]) => void
  leave: () => void
}

interface Kinds {
  confined: Kind | null
  probed: Kind | null
}

export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  const cache = new LRUCache<string, Promise<Kinds>>({
    ttl: STAT_TTL_MS,
    max: STAT_CACHE_MAX,
  })
  const ask = async (written: string, path: string, confinedOnly: boolean): Promise<Kinds> => {
    const confined = await deps.stat(path).catch(() => null)
    if (confined || confinedOnly || !path.startsWith('/')) return { confined, probed: null }
    return { confined, probed: await deps.probe(written).catch(() => null) }
  }
  const kindsCached = (written: string, path: string, confinedOnly: boolean): Promise<Kinds> => {
    const key = `${confinedOnly ? 'c' : 'p'}${path}`
    const hit = cache.get(key)
    if (hit) return hit
    const kinds = ask(written, path, confinedOnly)
    cache.set(key, kinds)
    return kinds
  }

  return {
    provideLinks(row, callback) {
      if (deps.remote()) {
        callback(undefined)
        return
      }
      const cwd = deps.cwd()
      const confinedOnly = deps.confinedOnly()
      const { text, cells } = readLogicalLine(term, row)
      const matches = matchesOnRow(findFileLinks(text), cells, row)
      if (matches.length === 0) {
        callback(undefined)
        return
      }
      provideFound(
        matches.map(async (m): Promise<ILink | null> => {
          const path = resolveLinkPath(m.path, cwd ?? '~')
          const kinds = await kindsCached(m.path, path, confinedOnly)
          const action = fileLinkAction({
            ...kinds,
            confinedOnly,
            revealable: kinds.confined === 'dir' && deps.revealable(path),
          })
          if (!action) return null
          const offers = pathLinkOffers(
            action,
            { confined: kinds.confined, confinedOnly },
            kinds.confined !== null && deps.revealable(path),
          )
          return {
            range: { start: cells[m.start], end: cells[m.end - 1] },
            text: text.slice(m.start, m.end),
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => {
              const how = deps.target(event)
              if (!how || !offers.includes(how) || deps.remote()) return
              if (needsHumanClick(how, action) && !event.isTrusted) return
              deps.activate(how, action, { written: m.path, path, line: m.line, column: m.column })
            },
            hover: () =>
              deps.hover({ start: cells[m.start], end: cells[m.end - 1] }, action, offers),
            leave: () => deps.leave(),
          }
        }),
        callback,
      )
    },
  }
}
