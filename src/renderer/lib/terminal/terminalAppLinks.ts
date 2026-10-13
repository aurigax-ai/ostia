import { findAppLinks } from '@shared/links/externalLinks'
import type { IBufferRange, ILink, ILinkHandler, ILinkProvider } from '@xterm/xterm'
import type { OstiaTerminal as Terminal, WebLinkHandler } from './ostiaTerminal'
import { readLogicalLine } from './terminalFileLinks'

export function xtermLinkHandler(links: WebLinkHandler): ILinkHandler {
  return { ...links, allowNonHttpProtocols: true }
}

export function createAppLinkProvider(term: Terminal, deps: WebLinkHandler): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const { text, cells } = readLogicalLine(term, row)
      const links: ILink[] = []
      for (const m of findAppLinks(text)) {
        const start = cells[m.start]
        const end = cells[m.end - 1]
        if (!start || !end || start.y > row || end.y < row) continue
        const range: IBufferRange = { start, end }
        links.push({
          range,
          text: m.url,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => deps.activate(event, m.url, range),
          hover: (event) => deps.hover(event, m.url, range),
          leave: (event) => deps.leave(event, m.url, range),
        })
      }
      callback(links.length > 0 ? links : undefined)
    },
  }
}
