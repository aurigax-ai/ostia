import { type FileUrlTarget, findFileUrls, opensFileUrl } from '@shared/files/fileUrls'
import { LRUCache } from 'lru-cache'
import type { OstiaTerminal as Terminal, TerminalLink, TerminalLinkProvider, TerminalRange, WebLinkHandler } from '@/lib/terminal/ostiaTerminal'
import type { PathLinkTarget } from './linkModifier'
import { matchesOnRow, provideFound, readLogicalLine } from './terminalFileLinks'

const CHECK_TTL_MS = 5_000
const CHECK_CACHE_MAX = 500

export type FileUrlAction = 'preview-page' | 'browse-page' | 'open-default'

export function fileUrlAction(target: FileUrlTarget, previews: boolean): FileUrlAction {
  if (target.opener === 'default-app') return 'open-default'
  return previews ? 'preview-page' : 'browse-page'
}

export function fileUrlOffers(action: FileUrlAction): PathLinkTarget[] {
  return action === 'preview-page' ? ['open', 'open-system'] : ['open']
}

export interface FileUrlDeps {
  remote: () => boolean
  check: (url: string) => Promise<FileUrlTarget | null>
  previews: (target: FileUrlTarget) => boolean
  target: (event: MouseEvent) => PathLinkTarget | null
  activate: (how: PathLinkTarget, url: string, target: FileUrlTarget, action: FileUrlAction) => void
  hover: (range: TerminalRange, target: FileUrlTarget, action: FileUrlAction) => void
  leave: () => void
}

interface FileUrlLinks {
  provider: (term: Terminal) => TerminalLinkProvider
  activate: (event: MouseEvent, url: string) => void
  hover: (range: TerminalRange, url: string) => void
  leave: () => void
}

export function createFileUrlLinks(deps: FileUrlDeps): FileUrlLinks {
  const cache = new LRUCache<string, Promise<FileUrlTarget | null>>({
    ttl: CHECK_TTL_MS,
    max: CHECK_CACHE_MAX,
  })
  let hovered: string | null = null
  const check = (url: string): Promise<FileUrlTarget | null> => {
    const hit = cache.get(url)
    if (hit) return hit
    const found = deps.check(url).catch(() => null)
    cache.set(url, found)
    return found
  }
  const activate = (event: MouseEvent, url: string): void => {
    if (!event.isTrusted || deps.remote() || !opensFileUrl(url)) return
    const how = deps.target(event)
    if (!how) return
    void check(url).then((target) => {
      if (!target) return
      const action = fileUrlAction(target, deps.previews(target))
      if (fileUrlOffers(action).includes(how)) deps.activate(how, url, target, action)
    })
  }
  const hover = (range: TerminalRange, url: string): void => {
    hovered = url
    if (deps.remote() || !opensFileUrl(url)) return
    void check(url).then((target) => {
      if (target && hovered === url) {
        deps.hover(range, target, fileUrlAction(target, deps.previews(target)))
      }
    })
  }
  const leave = (): void => {
    hovered = null
    deps.leave()
  }
  const provider = (term: Terminal): TerminalLinkProvider => ({
    provideLinks(row, callback) {
      if (deps.remote()) {
        callback(undefined)
        return
      }
      const { text, cells } = readLogicalLine(term, row)
      const matches = matchesOnRow(findFileUrls(text), cells, row)
      if (matches.length === 0) {
        callback(undefined)
        return
      }
      provideFound(
        matches.map(async (m): Promise<TerminalLink | null> => {
          if (!(await check(m.url))) return null
          const range: TerminalRange = { start: cells[m.start], end: cells[m.end - 1] }
          return {
            range,
            text: m.url,
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => activate(event, m.url),
            hover: () => hover(range, m.url),
            leave,
          }
        }),
        callback,
      )
    },
  })
  return { provider, activate, hover, leave }
}

function isFileUrl(uri: string): boolean {
  return /^file:/i.test(uri)
}

export function withFileUrls(links: WebLinkHandler, fileUrls: FileUrlLinks): WebLinkHandler {
  return {
    activate: (event, uri, range) =>
      isFileUrl(uri) ? fileUrls.activate(event, uri) : links.activate(event, uri, range),
    hover: (event, uri, range) =>
      isFileUrl(uri) ? fileUrls.hover(range, uri) : links.hover(event, uri, range),
    leave: (event, uri, range) =>
      isFileUrl(uri) ? fileUrls.leave() : links.leave(event, uri, range),
  }
}
