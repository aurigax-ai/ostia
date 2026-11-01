import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSpillChannels, spillInThread } from '../../../../test/historySpill'
import { ScreenMirror } from '../screenMirror'
import type { HistoryFeed } from './historyFeed'
import { newHistoryKey } from './historyRecords'
import { GAP_LINE, SPILL_BATCH } from './historySpill'
import { PaneHistory } from './paneHistory'

const ESC = '\x1b'
const mark = (kind: string) => `${ESC}]133;${kind}\x07`
const owned: { dispose(): void }[] = []
const feeds = new Map<ScreenMirror, HistoryFeed>()

function pane(): { history: PaneHistory; mirror: (cols?: number, rows?: number) => ScreenMirror } {
  const history = new PaneHistory({
    dir: join(mkdtempSync(join(tmpdir(), 'spill-')), 'pane'),
    key: newHistoryKey(),
    limitBytes: () => null,
    ensureSpace: async () => true,
    onFailed: vi.fn(),
  })
  owned.push(history)
  const spill = spillInThread()
  return {
    history,
    mirror: (cols = 80, rows = 24) => {
      const feed = spill.open(history, cols, rows)
      const mirror = new ScreenMirror(cols, rows, feed)
      feeds.set(mirror, feed)
      owned.push(mirror)
      return mirror
    },
  }
}

const spilled = (mirror: ScreenMirror): Promise<string[]> => mirror.historyTail()

async function closed(mirror: ScreenMirror): Promise<void> {
  await mirror.flush()
  mirror.dispose()
  await feeds.get(mirror)?.close()
}

const numbered = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `out ${from + i}\r\n`).join('')

async function plain(history: PaneHistory): Promise<string[]> {
  return (await history.read(history.first, history.end - history.first)).map((l) =>
    stripVTControlCharacters(l),
  )
}

afterEach(() => {
  for (const item of owned.splice(0).reverse()) item.dispose()
  feeds.clear()
  closeSpillChannels()
})

describe('HistorySpill', () => {
  it('spills each line once, in order, before the mirror trims it', async () => {
    const { history, mirror } = pane()
    const m = mirror()
    m.write(numbered(0, 10_000))
    await spilled(m)
    expect(history.end).toBeGreaterThan(10_000 - 2 * SPILL_BATCH)
    await closed(m)
    expect(await plain(history)).toEqual(Array.from({ length: 10_000 }, (_, i) => `out ${i}`))
  })

  it('keeps a background-coloured blank run and trims plain trailing blanks', async () => {
    const { history, mirror } = pane()
    const m = mirror(20)
    m.write(`plain   \r\n${ESC}[44mfill${ESC}[K${ESC}[0m\r\n`)
    m.write(numbered(0, 30))
    await closed(m)
    expect(await history.read(0, 2)).toEqual([
      'plain',
      `${ESC}[0;44mfill${' '.repeat(16)}${ESC}[0m`,
    ])
  })

  it('keeps colours and joins soft-wrapped rows into one line', async () => {
    const { history, mirror } = pane()
    const m = mirror(20)
    m.write(`${ESC}[31mred${ESC}[0m ${'w'.repeat(50)}\r\n`)
    m.write(numbered(0, SPILL_BATCH + 40))
    await spilled(m)
    const [first] = await history.read(0, 1)
    expect(first).toContain(`${ESC}[0;31mred`)
    expect(stripVTControlCharacters(first)).toBe(`red ${'w'.repeat(50)}`)
  })

  it('records where each command block starts and ends', async () => {
    const { history, mirror } = pane()
    const m = mirror()
    m.write(`${mark('A')}$ ${ESC}]633;E;make\x07${mark('B')}make\r\n${mark('C')}`)
    m.write(numbered(0, 3))
    m.write(`${mark('D;2')}${mark('A')}$ `)
    m.write(numbered(3, SPILL_BATCH + 40))
    await spilled(m)
    expect(history.block(1)).toEqual({
      seq: 1,
      start: 1,
      end: 4,
      endCol: 0,
      exitCode: 2,
      command: 'make',
    })
  })

  it('wipes the history when the program clears the scrollback', async () => {
    const { history, mirror } = pane()
    const m = mirror()
    m.write(numbered(0, 3000))
    await spilled(m)
    expect(history.end - history.first).toBeGreaterThan(0)
    m.write(`${ESC}[H${ESC}[2J${ESC}[3J`)
    m.write(numbered(5000, 5))
    await closed(m)
    expect(await plain(history)).toEqual([
      'out 5000',
      'out 5001',
      'out 5002',
      'out 5003',
      'out 5004',
    ])
  })

  it('does not spill a restored screen twice when the pane already has history', async () => {
    const { history, mirror } = pane()
    const first = mirror()
    first.write(numbered(0, 30))
    await closed(first)
    expect(history.end).toBe(30)
    const second = mirror()
    const restored = numbered(0, 30).trimEnd()
    second.restore(restored)
    second.write(numbered(30, 5))
    await closed(second)
    expect(await plain(history)).toEqual(Array.from({ length: 35 }, (_, i) => `out ${i}`))
  })

  it('marks lines it lost instead of skipping them silently', async () => {
    const { history, mirror } = pane()
    const m = mirror(10, 5)
    m.write('x'.repeat(10 * 60000))
    m.write('\r\nend\r\n')
    await closed(m)
    const lines = await plain(history)
    expect(lines).toContain(stripVTControlCharacters(GAP_LINE))
    expect(lines.at(-1)).toBe('end')
  })

  it('carries the block count over to the next shell of the pane', async () => {
    const { history, mirror } = pane()
    const first = mirror()
    first.write(`${mark('C')}${mark('D;0')}${mark('C')}`)
    await closed(first)
    expect(mirror().blockSeqBase).toBe(2)
    expect(history.seqOffset).toBe(2)
  })
})
