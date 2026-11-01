import type { HeadlessTerminal } from '@aurigax-ai/ghostty-web'
import { createHeadlessTerminal } from '@shared/terminal/ghosttyHeadless'
import { describe, expect, it, vi } from 'vitest'
import type {
  TerminalLink as ILink,
  TerminalLinkProvider as ILinkProvider,
  OstiaTerminal,
} from '@/lib/terminal/ostiaTerminal'
import { terminalLinkTarget } from './linkModifier'
import { createAppLinkProvider, hintedLinkHandler } from './terminalAppLinks'

const VAULT =
  'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md&newpane=true'

type Terminal = HeadlessTerminal

function terminalOf(cols: number, rows: number): Terminal {
  return createHeadlessTerminal({ cols, rows })
}

function write(term: Terminal, data: string): void {
  term.write(data)
}

function provide(provider: ILinkProvider, row: number): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
}

function handler() {
  return { activate: vi.fn(), hover: vi.fn(), leave: vi.fn() }
}

describe('createAppLinkProvider on a real terminal buffer', () => {
  it('links a wrapped angle-bracket target with spaces and wide characters', async () => {
    const term = terminalOf(40, 6)
    write(term, `see [中文](<${VAULT}>) ok`)
    const links = handler()
    const provider = createAppLinkProvider(term as unknown as OstiaTerminal, links)
    const rows = await Promise.all([1, 2, 3].map((row) => provide(provider, row)))
    for (const found of rows) {
      expect(found.map((l) => l.text)).toEqual([VAULT])
    }
    const [link] = rows[0]
    expect(link.range.start).toEqual({ x: 13, y: 1 })
    expect(link.range.end.y).toBe(3)
    const click = new MouseEvent('click')
    link.activate(click, link.text)
    expect(links.activate).toHaveBeenCalledWith(click, VAULT, link.range)
    term.dispose()
  })

  it('links plain vscode links and skips web and script links', async () => {
    const term = terminalOf(80, 4)
    write(term, 'vscode://file/a.ts:3 https://example.com javascript://x')
    const found = await provide(
      createAppLinkProvider(term as unknown as OstiaTerminal, handler()),
      1,
    )
    expect(found.map((l) => l.text)).toEqual(['vscode://file/a.ts:3'])
    term.dispose()
  })
})

describe('any scheme in the terminal', () => {
  it('links plain and angle-bracket links of any scheme and skips blocked ones', async () => {
    const term = terminalOf(120, 4)
    write(
      term,
      'slack://channel?id=1 [z](<zed://file/My Dir/a>) devtools://x foo::bar smb://h/s ms-msdt://i postgres://u:p@h/db',
    )
    const found = await provide(
      createAppLinkProvider(term as unknown as OstiaTerminal, handler()),
      1,
    )
    expect(found.map((l) => l.text)).toEqual(['slack://channel?id=1', 'zed://file/My Dir/a'])
    term.dispose()
  })
})

describe('hintedLinkHandler', () => {
  it('hands the hint the full target of a detected app link', async () => {
    const term = terminalOf(40, 6)
    write(term, `see [中文](<${VAULT}>) ok`)
    const hint = { show: vi.fn(), hide: vi.fn() }
    const provider = createAppLinkProvider(
      term as unknown as OstiaTerminal,
      hintedLinkHandler(vi.fn(), hint),
    )
    const [link] = await provide(provider, 2)
    link.hover?.(new MouseEvent('mouseover'), link.text)
    expect(hint.show).toHaveBeenCalledWith(link.range, VAULT)
    term.dispose()
  })

  it('shows no hint for a link it would not open', () => {
    const hint = { show: vi.fn(), hide: vi.fn() }
    const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }
    hintedLinkHandler(vi.fn(), hint).hover(new MouseEvent('mouseover'), 'javascript:x', range)
    expect(hint.show).not.toHaveBeenCalled()
  })
})

describe('the link forms Claude Code prints', () => {
  const A = VAULT
  const B =
    'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD.md'
  const C = 'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=a.md'
  const D = 'https://gitlab.fism.app'

  async function screen(lines: string[]) {
    const term = terminalOf(200, 8)
    write(term, lines.join('\r\n'))
    const app = createAppLinkProvider(term as unknown as OstiaTerminal, handler())
    const rows = await Promise.all(lines.map((_, i) => provide(app, i + 1)))
    term.dispose()
    return rows.map((links) => links.map((l) => l.text))
  }

  const click = { ctrlKey: false, metaKey: false, shiftKey: false, detail: 1 }
  const ctx = { mac: true, hasSelection: false, mouseReporting: false, linkClick: 'app' as const }

  it('shows the raw markdown forms as links when a program prints them unrendered', async () => {
    const raw = [`[A](<${A}>)`, `[B](${B})`, C, `[GitLab](${D})`]
    expect(await screen(raw)).toEqual([[A], [B], [C], []])
  })

  it('opens A, B and C in their app and D in the browser on a plain click', () => {
    expect([A, B, C, D].map((uri) => terminalLinkTarget(uri, click, ctx))).toEqual([
      'app',
      'app',
      'app',
      'same-tab',
    ])
  })
})
