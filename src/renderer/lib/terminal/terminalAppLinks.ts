import { findAppLinks } from '@shared/links/externalLinks'
import type { IBufferRange, ILink, ILinkProvider } from '@xterm/xterm'
import type { OstiaTerminal as Terminal } from './ostiaTerminal'
import { readLogicalLine } from './terminalFileLinks'

export interface AppLinkDeps {
  activate: (event: MouseEvent, url: string, range: IBufferRange) => void
  hover: (event: MouseEvent, url: string, range: IBufferRange) => void
  leave: (event: MouseEvent, url: string, range: IBufferRange) => void
}

export function createAppLinkProvider(term: Terminal, deps: AppLinkDeps): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const { text, cells } = readLogicalLine(term, row)
      const links: ILink[] = []
      for (const m of findAppLinks(text)) {
        const start = cells[m.start]
        const end = cells[m.end - 1]
        if (!start || !end || start.y > row || end.y < row) continue
        const range = { start, end }
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
