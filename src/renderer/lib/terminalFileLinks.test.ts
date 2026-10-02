import type { ILink, Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { createFileLinkProvider, readLogicalLine } from './terminalFileLinks'

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
) {
  const open = vi.fn()
  const provider = createFileLinkProvider(term, {
    cwd: () => '/home/u/proj',
    remote: () => remote,
    stat,
    open,
    modifierHeld: (e) => e.ctrlKey,
  })
  return new Promise<{ links: ILink[] | undefined; open: typeof open }>((resolve) =>
    provider.provideLinks(row, (links) => resolve({ links, open })),
  )
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
    expect(open).toHaveBeenCalledWith('/home/u/proj/src/app.ts', 12, 4)
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

  it('evicts old entries when cache exceeds max size', async () => {
    const stat = vi.fn(async (): Promise<'file' | 'dir' | null> => 'file')
    const open = vi.fn()

    const rows: { text: string }[] = [{ text: 'file0.ts' }]
    for (let i = 1; i <= 550; i++) {
      rows.push({ text: `file${i}.ts` })
    }

    const provider = createFileLinkProvider(fakeTerminal(rows), {
      cwd: () => '/home/u/proj',
      remote: () => false,
      stat,
      open,
      modifierHeld: () => false,
    })

    await new Promise<void>((resolve) =>
      provider.provideLinks(1, () => {
        resolve()
      }),
    )
    const firstCallCount = stat.mock.calls.length
    expect(firstCallCount).toBeGreaterThan(0)

    await new Promise<void>((resolve) =>
      provider.provideLinks(1, () => {
        resolve()
      }),
    )
    const secondCallCount = stat.mock.calls.length
    expect(secondCallCount).toBe(firstCallCount)

    for (let i = 2; i <= 551; i++) {
      stat.mockClear()
      await new Promise<void>((resolve) =>
        provider.provideLinks(i, () => {
          resolve()
        }),
      )
    }

    stat.mockClear()
    await new Promise<void>((resolve) =>
      provider.provideLinks(1, () => {
        resolve()
      }),
    )
    expect(stat).toHaveBeenCalled()
  })
})
