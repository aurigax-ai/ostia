import { type ILink, type ILinkProvider, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { terminalLinkTarget } from './linkModifier'
import type { OstiaTerminal } from './ostiaTerminal'
import { createAppLinkProvider, xtermLinkHandler } from './terminalAppLinks'

const VAULT =
  'obsidian://advanced-uri?vault=Interdisciplinary Nexus&filepath=05 Projects/中文.md&newpane=true'

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve))
}

function provide(provider: ILinkProvider, row: number): Promise<ILink[]> {
  return new Promise((resolve) => provider.provideLinks(row, (links) => resolve(links ?? [])))
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

describe('xtermLinkHandler', () => {
  function oscLinks(term: Terminal, row: number): Promise<ILink[]> {
    const core = (
      term as unknown as { _core: { _linkProviderService: { linkProviders: ILinkProvider[] } } }
    )._core
    return provide(core._linkProviderService.linkProviders[0], row)
  }

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
  const ctx = { mac: true, hasSelection: false, mouseReporting: false }

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
