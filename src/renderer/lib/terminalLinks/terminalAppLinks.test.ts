import { type ILink, type ILinkProvider, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import type { OstiaTerminal } from '@/lib/terminal/ostiaTerminal'
import { terminalLinkTarget } from './linkModifier'
import { createAppLinkProvider, hintedLinkHandler, xtermLinkHandler } from './terminalAppLinks'

const VAULT =
  'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md&newpane=true'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function provide(provider: ILinkProvider, row: number): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
}

function oscLinks(term: Terminal, row: number): Promise<ILink[]> {
  const core = (
    term as unknown as { _core: { _linkProviderService: { linkProviders: ILinkProvider[] } } }
  )._core
  return provide(core._linkProviderService.linkProviders[0], row)
}

function handler() {
  return { activate: vi.fn(), hover: vi.fn(), leave: vi.fn() }
}

describe('createAppLinkProvider on a real xterm buffer', () => {
  it('links a wrapped angle-bracket target with spaces and wide characters', async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    await write(term, `see [中文](<${VAULT}>) ok`)
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
    const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
    await write(term, 'vscode://file/a.ts:3 https://example.com javascript://x')
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
    const term = new Terminal({ cols: 120, rows: 4, allowProposedApi: true })
    await write(
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

  it('opens an OSC 8 link of any scheme in its app and hints its full target', async () => {
    const slack = 'slack://channel?team=T1&id=C2'
    const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
    const hint = { show: vi.fn(), hide: vi.fn() }
    term.options.linkHandler = xtermLinkHandler(hintedLinkHandler(vi.fn(), hint))
    await write(term, `\x1b]8;;${slack}\x07channel\x1b]8;;\x07`)
    const [link] = await oscLinks(term, 1)
    link.hover?.(new MouseEvent('mouseover'), link.text)
    expect(hint.show).toHaveBeenCalledWith(link.range, slack)
    const click = { ctrlKey: false, metaKey: false, shiftKey: false, detail: 1 }
    const ctx = { mac: true, hasSelection: false, mouseReporting: false, linkClick: 'app' as const }
    expect(terminalLinkTarget(link.text, click, ctx)).toBe('app')
    term.dispose()
  })
})

describe('xtermLinkHandler', () => {
  it('lets OSC 8 hyperlinks to obsidian reach the handler, as Claude Code prints them', async () => {
    const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
    const links = handler()
    term.options.linkHandler = xtermLinkHandler(links)
    await write(term, `\x1b]8;id=1411o5u;${VAULT}\x07Vault note\x1b]8;;\x07`)
    const [link] = await oscLinks(term, 1)
    expect(link?.text).toBe(VAULT)
    const click = new MouseEvent('click')
    link.activate(click, link.text)
    expect(links.activate).toHaveBeenCalledWith(click, VAULT, link.range)
    term.dispose()
  })

  it('links a one-cell OSC 8 hyperlink that starts right where another ends at the line end', async () => {
    const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
    term.options.linkHandler = xtermLinkHandler(handler())
    const first = 'https://a.example/'
    const second = 'obsidian://open?vault=b'
    await write(term, `\x1b]8;id=a;${first}\x07abc\x1b]8;id=b;${second}\x07d\x1b]8;;\x07`)
    const found = await oscLinks(term, 1)
    expect(found.map((l) => [l.text, l.range.start.x, l.range.end.x])).toEqual([
      [first, 1, 3],
      [second, 4, 4],
    ])
    term.dispose()
  })
})

describe('hintedLinkHandler', () => {
  it('hands the hint the full target of an OSC 8 link, not the text it shows', async () => {
    const append = 'obsidian://new?vault=Notes&file=log&content=rm%20-rf&append=true'
    const web = 'https://example.com/a?b=c'
    const term = new Terminal({ cols: 80, rows: 4, allowProposedApi: true })
    const hint = { show: vi.fn(), hide: vi.fn() }
    term.options.linkHandler = xtermLinkHandler(hintedLinkHandler(vi.fn(), hint))
    await write(
      term,
      `\x1b]8;;${append}\x07Open note\x1b]8;;\x07 \x1b]8;;${web}\x07docs\x1b]8;;\x07`,
    )
    const links = await oscLinks(term, 1)
    const event = new MouseEvent('mouseover')
    for (const link of links) link.hover?.(event, link.text)
    expect(hint.show.mock.calls).toEqual([
      [links[0].range, append],
      [links[1].range, web],
    ])
    links[0].leave?.(event, links[0].text)
    expect(hint.hide).toHaveBeenCalledOnce()
    term.dispose()
  })

  it('hands the hint the full target of a detected app link', async () => {
    const term = new Terminal({ cols: 40, rows: 6, allowProposedApi: true })
    await write(term, `see [中文](<${VAULT}>) ok`)
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

describe('the four link forms Claude Code prints', () => {
  const A = VAULT
  const B =
    'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=05%20Projects/%E4%B8%AD.md'
  const C = 'obsidian://advanced-uri?vault=Interdisciplinary%20Nexus&filepath=a.md'
  const D = 'https://gitlab.fism.app'
  const osc8 = (target: string, text: string) =>
    `\x1b]8;id=${text};${target}\x07${text}\x1b]8;;\x07`

  async function screen(lines: string[], raw: boolean) {
    const term = new Terminal({ cols: 200, rows: 8, allowProposedApi: true })
    if (!raw) term.options.linkHandler = xtermLinkHandler(handler())
    await write(term, lines.join('\r\n'))
    const core = (
      term as unknown as { _core: { _linkProviderService: { linkProviders: ILinkProvider[] } } }
    )._core
    const osc = core._linkProviderService.linkProviders[0]
    const app = createAppLinkProvider(term as unknown as OstiaTerminal, handler())
    const rows = await Promise.all(
      lines.map(async (_, i) => [...(await provide(osc, i + 1)), ...(await provide(app, i + 1))]),
    )
    term.dispose()
    return rows.map((links) => links.map((l) => l.text))
  }

  const rendered = [osc8(A, 'A'), osc8(B, 'B'), C, osc8(D, 'GitLab')]
  const click = { ctrlKey: false, metaKey: false, shiftKey: false, detail: 1 }
  const ctx = { mac: true, hasSelection: false, mouseReporting: false, linkClick: 'app' as const }

  it('shows every form as a link, the way Claude Code renders them', async () => {
    expect(await screen(rendered, false)).toEqual([[A], [B], [C], [D]])
  })

  it('shows only the web link before the change, as reported', async () => {
    const term = new Terminal({ cols: 200, rows: 8, allowProposedApi: true })
    term.options.linkHandler = handler()
    await write(term, rendered.join('\r\n'))
    const core = (
      term as unknown as { _core: { _linkProviderService: { linkProviders: ILinkProvider[] } } }
    )._core
    const found = await Promise.all(
      [1, 2, 3, 4].map((row) => provide(core._linkProviderService.linkProviders[0], row)),
    )
    expect(found.map((links) => links.map((l) => l.text))).toEqual([[], [], [], [D]])
    term.dispose()
  })

  it('shows the raw markdown forms as links when a program prints them unrendered', async () => {
    const raw = [`[A](<${A}>)`, `[B](${B})`, C, `[GitLab](${D})`]
    expect(await screen(raw, false)).toEqual([[A], [B], [C], []])
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
