import type { ILink, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import {
  type FileLinkDeps,
  createFileLinkProvider,
  fileLinkAction,
  readLogicalLine,
} from './terminalFileLinks'

function fakeTerminal(rows: { text: string; wrapped?: boolean; wide?: number[] }[]): Terminal {
  const lines = rows.map((row) => {
    const cells: { chars: string; width: number }[] = []
    for (const ch of row.text) {
      const wide = row.wide?.includes(cells.length) ?? false
      cells.push({ chars: ch, width: wide ? 2 : 1 })
      if (wide) cells.push({ chars: '', width: 0 })
    }
    return {
      isWrapped: row.wrapped ?? false,
      length: cells.length,
      getCell: (x: number) => {
        const c = cells[x]
        return c ? { getChars: () => c.chars, getWidth: () => c.width } : undefined
      },
    }
  })
  return {
    buffer: { active: { length: lines.length, getLine: (y: number) => lines[y] } },
  } as unknown as Terminal
}

function linksFor(
  term: Terminal,
  row: number,
  stat = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file'),
  remote = false,
  more: Partial<FileLinkDeps> = {},
) {
  const open = vi.fn()
  const hover = vi.fn()
  const leave = vi.fn()
  const provider = createFileLinkProvider(term, {
    cwd: () => '/home/u/proj',
    remote: () => remote,
    confinedOnly: () => false,
    revealable: () => false,
    stat,
    probe: async () => null,
    activate: open,
    modifierHeld: (e) => e.ctrlKey,
    hover,
    leave,
    ...more,
  })
  return new Promise<{
    links: ILink[] | undefined
    open: typeof open
    hover: typeof hover
    leave: typeof leave
  }>((resolve) => provider.provideLinks(row, (links) => resolve({ links, open, hover, leave })))
}

describe('readLogicalLine', () => {
  it('joins wrapped rows and maps each character to its cell, skipping wide-char spacers', () => {
    const term = fakeTerminal([
      { text: '字ab', wide: [0] },
      { text: 'cd', wrapped: true },
    ])
    const { text, cells } = readLogicalLine(term, 2)
    expect(text).toBe('字abcd')
    expect(cells.map((c) => `${c.x},${c.y}`)).toEqual(['1,1', '3,1', '4,1', '1,2', '2,2'])
  })
})

describe('createFileLinkProvider', () => {
  it('links an existing file across a wrapped row and opens it at its line on Ctrl+click', async () => {
    const term = fakeTerminal([
      { text: 'error in src/ap' },
      { text: 'p.ts:12:4 here', wrapped: true },
    ])
    const stat = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file')
    const { links, open } = await linksFor(term, 2, stat)
    expect(stat).toHaveBeenCalledWith('/home/u/proj/src/app.ts')
    expect(links).toHaveLength(1)
    const [link] = links ?? []
    expect(link.text).toBe('src/app.ts:12:4')
    expect(link.range).toEqual({ start: { x: 10, y: 1 }, end: { x: 9, y: 2 } })
    expect(link.decorations?.pointerCursor).toBe(true)

    link.activate(new MouseEvent('click'), link.text)
    expect(open).not.toHaveBeenCalled()
    link.activate(new MouseEvent('click', { ctrlKey: true }), link.text)
    expect(open).toHaveBeenCalledWith('open-file', '/home/u/proj/src/app.ts', 12, 4)
  })

  it('reports the hovered link range and when the pointer leaves it', async () => {
    const term = fakeTerminal([{ text: 'see src/app.ts now' }])
    const { links, hover, leave } = await linksFor(term, 1)
    const [link] = links ?? []
    link.hover?.(new MouseEvent('mousemove'), link.text)
    expect(hover).toHaveBeenCalledWith({ start: { x: 5, y: 1 }, end: { x: 14, y: 1 } }, 'open-file')
    link.leave?.(new MouseEvent('mousemove'), link.text)
    expect(leave).toHaveBeenCalledTimes(1)
  })

  it('SSH-C37 offers no local file link while the pane is in a remote shell', async () => {
    const term = fakeTerminal([{ text: 'error in src/app.ts:12' }])
    const stat = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file')
    const { links } = await linksFor(term, 1, stat, true)
    expect(links).toBeUndefined()
    expect(stat).not.toHaveBeenCalled()
  })

  it('offers no link for a path that is not an existing file', async () => {
    const term = fakeTerminal([{ text: 'see missing/file.ts' }])
    const { links } = await linksFor(
      term,
      1,
      vi.fn(async (): Promise<'file' | 'dir' | null> => null),
    )
    expect(links).toBeUndefined()
  })

  it('asks again about a path only after five seconds, so a file made since then gets its link', async () => {
    let now = 1_000
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const pass = async (ms: number): Promise<void> => {
      now += ms
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    try {
      const term = fakeTerminal([{ text: 'wrote out/report.txt' }])
      const stat = vi.fn(async (): Promise<'file' | 'dir' | null> => null)
      const provider = createFileLinkProvider(term, {
        cwd: () => '/home/u/proj',
        remote: () => false,
        confinedOnly: () => false,
        revealable: () => false,
        stat,
        probe: async () => null,
        activate: vi.fn(),
        modifierHeld: () => false,
        hover: vi.fn(),
        leave: vi.fn(),
      })
      const links = () =>
        new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve))

      expect(await links()).toBeUndefined()
      stat.mockResolvedValue('file')
      await pass(4_900)
      expect(await links()).toBeUndefined()
      expect(stat).toHaveBeenCalledTimes(1)

      await pass(200)
      expect(await links()).toHaveLength(1)
      expect(stat).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  })

  it('forgets the paths asked about longest ago once it holds five hundred', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ text: `file${i}.ts` }))
    const stat = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file')
    const provider = createFileLinkProvider(fakeTerminal(rows), {
      cwd: () => '/home/u/proj',
      remote: () => false,
      confinedOnly: () => false,
      revealable: () => false,
      stat,
      probe: async () => null,
      activate: vi.fn(),
      modifierHeld: () => false,
      hover: vi.fn(),
      leave: vi.fn(),
    })
    const visit = (row: number) =>
      new Promise<void>((resolve) => provider.provideLinks(row, () => resolve()))

    await visit(1)
    await visit(1)
    expect(stat).toHaveBeenCalledTimes(1)

    for (let row = 2; row <= 501; row++) await visit(row)
    stat.mockClear()
    await visit(501)
    expect(stat).not.toHaveBeenCalled()
    await visit(1)
    expect(stat).toHaveBeenCalledWith('/home/u/proj/file0.ts')
  })
})

const humanClick = { ctrlKey: true, isTrusted: true } as MouseEvent
const noKind = async (): Promise<'file' | 'dir' | null> => null

describe('fileLinkAction', () => {
  const facts = { confined: null, probed: null, revealable: false, confinedOnly: false }

  it('opens a file the confined stat sees and admits one only main can see', () => {
    expect(fileLinkAction({ ...facts, confined: 'file' })).toBe('open-file')
    expect(fileLinkAction({ ...facts, probed: 'file' })).toBe('admit-file')
  })

  it('reveals a folder under the Files root and hands any other folder to the file manager', () => {
    expect(fileLinkAction({ ...facts, confined: 'dir', revealable: true })).toBe('reveal-folder')
    expect(fileLinkAction({ ...facts, confined: 'dir' })).toBe('open-folder')
    expect(fileLinkAction({ ...facts, probed: 'dir' })).toBe('open-folder')
  })

  it('leaves a path that is neither a file nor a folder as plain text', () => {
    expect(fileLinkAction(facts)).toBeNull()
  })

  it('in a sandboxed or scratch workspace offers only what stays inside the app', () => {
    const confinedOnly = { ...facts, confinedOnly: true }
    expect(fileLinkAction({ ...confinedOnly, confined: 'file' })).toBe('open-file')
    expect(fileLinkAction({ ...confinedOnly, confined: 'dir', revealable: true })).toBe(
      'reveal-folder',
    )
    expect(fileLinkAction({ ...confinedOnly, confined: 'dir' })).toBeNull()
    expect(fileLinkAction({ ...confinedOnly, probed: 'file' })).toBeNull()
    expect(fileLinkAction({ ...confinedOnly, probed: 'dir' })).toBeNull()
  })
})

describe('createFileLinkProvider outside home and folders', () => {
  it('asks main about an absolute path the confined stat cannot see and admits it on a human Ctrl+click', async () => {
    const term = fakeTerminal([{ text: 'saved /tmp/shots/a.png:3' }])
    const probe = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file')
    const { links, open, hover } = await linksFor(term, 1, vi.fn(noKind), false, { probe })
    expect(probe).toHaveBeenCalledWith('/tmp/shots/a.png')
    const [link] = links ?? []
    link.hover?.(new MouseEvent('mousemove'), link.text)
    expect(hover.mock.calls[0][1]).toBe('admit-file')

    link.activate(humanClick, link.text)
    expect(open).toHaveBeenCalledWith('admit-file', '/tmp/shots/a.png', 3, undefined)
  })

  it('never admits a file or opens the file manager for a click the human did not make', async () => {
    const scripted = new MouseEvent('click', { ctrlKey: true })
    for (const kind of ['file', 'dir'] as const) {
      const term = fakeTerminal([{ text: 'see /tmp/out' }])
      const { links, open } = await linksFor(term, 1, vi.fn(noKind), false, {
        probe: async () => kind,
      })
      const [link] = links ?? []
      link.activate(scripted, link.text)
      expect(open).not.toHaveBeenCalled()
    }
  })

  it('never asks main while the pane is remote, sandboxed or scratch, or for a path under ~', async () => {
    const probe = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file')
    const term = fakeTerminal([{ text: 'see /tmp/out.txt' }])
    expect((await linksFor(term, 1, vi.fn(noKind), true, { probe })).links).toBeUndefined()
    expect(
      (await linksFor(term, 1, vi.fn(noKind), false, { probe, confinedOnly: () => true })).links,
    ).toBeUndefined()
    expect(
      (await linksFor(term, 1, vi.fn(noKind), false, { probe, cwd: () => null })).links,
    ).toHaveLength(1)
    probe.mockClear()
    const homeTerm = fakeTerminal([{ text: 'see ~/gone.txt' }])
    expect((await linksFor(homeTerm, 1, vi.fn(noKind), false, { probe })).links).toBeUndefined()
    expect(probe).not.toHaveBeenCalled()
  })

  it('does not act on a link whose pane turned remote after it was drawn', async () => {
    let remote = false
    const term = fakeTerminal([{ text: 'see src/app.ts' }])
    const { links, open } = await linksFor(term, 1, undefined, false, { remote: () => remote })
    remote = true
    const [link] = links ?? []
    link.activate(humanClick, link.text)
    expect(open).not.toHaveBeenCalled()
  })

  it('links a folder and says whether a click reveals it in Files or opens the file manager', async () => {
    const stat = vi.fn(async (): Promise<'file' | 'dir' | null> => 'dir')
    const term = fakeTerminal([{ text: 'built src/renderer/ ok' }])
    const inside = await linksFor(term, 1, stat, false, { revealable: () => true })
    const [revealed] = inside.links ?? []
    expect(revealed.text).toBe('src/renderer')
    revealed.hover?.(new MouseEvent('mousemove'), revealed.text)
    expect(inside.hover.mock.calls[0][1]).toBe('reveal-folder')
    revealed.activate(new MouseEvent('click', { ctrlKey: true }), revealed.text)
    expect(inside.open).toHaveBeenCalledWith(
      'reveal-folder',
      '/home/u/proj/src/renderer',
      undefined,
      undefined,
    )

    const outside = await linksFor(term, 1, stat)
    const [opened] = outside.links ?? []
    opened.hover?.(new MouseEvent('mousemove'), opened.text)
    expect(outside.hover.mock.calls[0][1]).toBe('open-folder')
    opened.activate(humanClick, opened.text)
    expect(outside.open).toHaveBeenCalledWith(
      'open-folder',
      '/home/u/proj/src/renderer',
      undefined,
      undefined,
    )
  })
})
