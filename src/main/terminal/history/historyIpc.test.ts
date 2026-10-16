import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSpillChannels, spillInThread } from '../../../../test/historySpill'
import type { PtyEntry } from '../pty/ptyRegistry'
import { ScreenMirror } from '../screenMirror'
import { PaneHistories } from './paneHistories'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}))

const { registerHistoryIpc } = await import('./historyIpc')
const { lineMatcher, outputText, sameCommand } = await import('./historySearch')

const ESC = '\x1b'
const mark = (kind: string) => `${ESC}]133;${kind}\x07`
const cleanup: (() => void)[] = []

function setup() {
  const histories = new PaneHistories({
    root: mkdtempSync(join(tmpdir(), 'history-ipc-')),
    setting: () => 'unlimited',
    startSpill: spillInThread,
  })
  const mirror = new ScreenMirror(80, 24, histories.feedFor('p1', 80, 24))
  const ptys = new Map([['p1', { mirror } as unknown as PtyEntry]])
  registerHistoryIpc({
    ptys,
    windowOfPane: (paneId) => (paneId === 'p1' ? '7' : undefined),
    services: { histories },
  })
  cleanup.push(() => {
    mirror.dispose()
    histories.removeAll()
  })
  const call = (sender: number, channel: string, ...args: unknown[]) =>
    handlers.get(channel)?.({ sender: { id: sender } }, ...args)
  const write = async (data: string) => {
    mirror.write(data)
    await mirror.flush()
    await mirror.historyTail()
  }
  const send = (data: string) => mirror.write(data)
  return { call, write, send }
}

const numbered = (from: number, count: number, text = 'out'): string =>
  Array.from({ length: count }, (_, i) => `${text} ${from + i}\r\n`).join('')

afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
  closeSpillChannels()
})

describe('history IPC', () => {
  it('answers only the window that owns the pane', async () => {
    const { call, write } = setup()
    await write(numbered(0, 10))
    expect(await call(8, 'pty:history-read', 'p1', 0, 10)).toBeNull()
    expect(await call(8, 'pty:history-search', 'p1', 'out', {}, 0)).toBeNull()
    expect(await call(8, 'pty:block-output', 'p1', 1, '')).toBeNull()
    expect(await call(7, 'pty:history-read', 'p2', 0, 10)).toBeNull()
  })

  it('reads spilled lines and the unspilled screen as one numbered history', async () => {
    const { call, write } = setup()
    await write(numbered(0, 3000))
    const page = (await call(7, 'pty:history-read', 'p1', 2990, 20)) as {
      first: number
      end: number
      from: number
      lines: string[]
    }
    expect(page.first).toBe(0)
    expect(page.end).toBe(3000)
    expect(page.from).toBe(2990)
    expect(page.lines).toEqual(numbered(2990, 10).trimEnd().split('\r\n'))
  })

  it('searches only lines older than the live terminal holds, newest matches last', async () => {
    const { call, write } = setup()
    await write(numbered(0, 3000, 'needle'))
    const result = (await call(7, 'pty:history-search', 'p1', 'NEEDLE 2', {}, 1000)) as {
      count: number
      matches: { line: number; start: number; end: number }[]
    }
    expect(result.count).toBe(1 + 10 + 100)
    expect(result.matches.at(-1)).toEqual({ line: 299, start: 0, end: 8 })
    const all = (await call(7, 'pty:history-search', 'p1', 'needle', {}, 0)) as typeof result
    expect(all.count).toBeGreaterThan(2000)
    expect(all.matches).toHaveLength(1000)
    expect(all.matches.at(-1)?.line).toBe(all.count - 1)
  })

  it('returns a spilled block whole, without the next prompt', async () => {
    const { call, write } = setup()
    await write(`${mark('A')}$ ${ESC}]633;E;build;n0nce\x07${mark('B')}build\r\n${mark('C')}`)
    await write(numbered(0, 2500))
    await write(`${mark('D;1')}${mark('A')}$ `)
    const output = (await call(7, 'pty:block-output', 'p1', 1, 'build')) as string
    expect(output.split('\n')).toEqual(numbered(0, 2500).trimEnd().split('\r\n'))
    expect(await call(7, 'pty:block-output', 'p1', 1, 'other')).toBeNull()
    expect(await call(7, 'pty:history-block', 'p1', 1, 'build')).toEqual({ start: 1, end: 2501 })
  })
  it('reads what was just written, without waiting for the pane to go quiet', async () => {
    const { call, send } = setup()
    send(numbered(0, 3000))
    const page = (await call(7, 'pty:history-read', 'p1', 0, 10)) as {
      end: number
      lines: string[]
    }
    expect(page.end).toBe(3000)
    expect(page.lines).toEqual(numbered(0, 10).trimEnd().split('\r\n'))
  })

  it('never shows a cleared line, even when asked right after the clear', async () => {
    const { call, write, send } = setup()
    await write(`${mark('A')}$ ${ESC}]633;E;build;n0nce\x07${mark('B')}build\r\n${mark('C')}`)
    await write(numbered(0, 2500))
    await write(`${mark('D;0')}${mark('A')}$ `)
    send(`${ESC}[3J`)
    expect(await call(7, 'pty:history-block', 'p1', 1, 'build')).toBeNull()
    const page = (await call(7, 'pty:history-read', 'p1', 0, 5000)) as { lines: string[] }
    expect(page.lines).not.toContain('out 10')
    const found = (await call(7, 'pty:history-search', 'p1', 'out 10', {}, 0)) as { count: number }
    expect(found.count).toBe(0)
  })
})

describe('history search helpers', () => {
  it('matches literally by default, ignoring case', () => {
    expect(lineMatcher('a.b', {})?.('A.B axb')).toEqual([{ start: 0, end: 3 }])
    expect(lineMatcher('a.b', { regex: true })?.('axb')).toEqual([{ start: 0, end: 3 }])
    expect(lineMatcher('ab', { caseSensitive: true })?.('AB ab')).toEqual([{ start: 3, end: 5 }])
    expect(lineMatcher('ab', { wholeWord: true })?.('abc ab')).toEqual([{ start: 4, end: 6 }])
    expect(lineMatcher('(', { regex: true })).toBeNull()
  })

  it('cuts the last line at the end column and drops colours and trailing blanks', () => {
    expect(outputText([`${ESC}[31mred${ESC}[0m  `, 'two$ prompt'], 3)).toBe('red\ntwo')
    expect(outputText(['one', '$ prompt'], 0)).toBe('one')
    expect(outputText(['one', 'two', ''], null)).toBe('one\ntwo')
  })

  it('compares commands by their first line', () => {
    expect(sameCommand(null, 'ls')).toBe(true)
    expect(sameCommand('cat <<EOF\nx\nEOF', 'cat <<EOF')).toBe(true)
    expect(sameCommand('ls', 'make')).toBe(false)
  })
})
