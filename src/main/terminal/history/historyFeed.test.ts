import { execFile } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify, stripVTControlCharacters } from 'node:util'
import { build } from 'esbuild'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeSpillChannels,
  HISTORY_WORKER_SCRIPT,
  spillInThread,
} from '../../../../test/historySpill'
import { ScreenMirror } from '../screenMirror'
import {
  PANE_SEND_CHARS,
  SLICE_CHARS,
  SPILL_BACKLOG,
  SpillClient,
  type SpillPort,
  type SpillPressure,
  startSpillWorker,
} from './historyFeed'
import { newHistoryKey } from './historyRecords'
import { GAP_LINE, SPILL_BATCH, type SpillSink } from './historySpill'
import { PaneHistories } from './paneHistories'
import { PaneHistory } from './paneHistory'
import type { SpillEvent, SpillRequest } from './spillHost'
import { SPILL_SCROLLBACK, SpillTerminal } from './spillTerminal'

const ESC = '\x1b'
const GIB = 1024 * 1024 * 1024
const run = promisify(execFile)
const electronBinary = createRequire(__filename)('electron') as unknown as string
const mark = (kind: string) => `${ESC}]133;${kind}\x07`
const owned: { dispose(): void | Promise<void> }[] = []
const clients: SpillClient[] = []

function makeHistory(onFailed = vi.fn()): PaneHistory {
  const history = new PaneHistory({
    dir: join(mkdtempSync(join(tmpdir(), 'feed-')), 'pane'),
    key: newHistoryKey(),
    limitBytes: () => null,
    ensureSpace: async () => true,
    onFailed,
  })
  owned.push(history)
  return history
}

function makeHistories(): PaneHistories {
  const histories = new PaneHistories({
    root: mkdtempSync(join(tmpdir(), 'feeds-')),
    setting: () => 'unlimited',
    startSpill: spillInThread,
  })
  owned.push({ dispose: () => histories.removeAll() })
  return histories
}

function fakePort() {
  const posted: SpillRequest[] = []
  let listener: (event: SpillEvent) => void = () => undefined
  const port: SpillPort = {
    postMessage: (request) => posted.push(request),
    on: (_type, l) => {
      listener = l
    },
  }
  return { port, posted, answer: (event: SpillEvent) => listener(event) }
}

function countingPressure(canPause: boolean) {
  const counts = { held: 0, released: 0 }
  const pressure: SpillPressure = {
    canPause,
    hold: (chars) => {
      counts.held += chars
    },
    release: (chars) => {
      counts.released += chars
    },
    close: () => undefined,
  }
  return { pressure, counts }
}

const writesOf = (posted: SpillRequest[]) =>
  posted.filter((r): r is Extract<SpillRequest, { kind: 'write' }> => r.kind === 'write')

const numbered = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `out ${from + i}\r\n`).join('')

async function plain(history: PaneHistory): Promise<string[]> {
  return (await history.read(history.first, history.end - history.first)).map((l) =>
    stripVTControlCharacters(l),
  )
}

afterEach(async () => {
  vi.useRealTimers()
  for (const item of owned.splice(0).reverse()) await item.dispose()
  for (const client of clients.splice(0)) client.end('test-done')
  closeSpillChannels()
})

describe('history feed', () => {
  it('keeps every line the worker could still spill: a batch fits in its scrollback', () => {
    expect(SPILL_BATCH).toBeLessThan(SPILL_SCROLLBACK)
  })

  it('spills through the built worker', async () => {
    const client = startSpillWorker(HISTORY_WORKER_SCRIPT)
    clients.push(client)
    const history = makeHistory()
    const feed = client.open(history, 80, 24)
    feed.write(numbered(0, 3 * SPILL_BATCH))
    await feed.close()
    expect(await plain(history)).toEqual(
      Array.from({ length: 3 * SPILL_BATCH }, (_, i) => `out ${i}`),
    )
  })

  it('caps the worker heap under the runtime the app ships, whatever this test process was started with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heap-probe-'))
    const probe = join(dir, 'heapProbe.cjs')
    await build({
      entryPoints: [resolve(__dirname, '../../../../test/fixtures/history/heapProbe.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: probe,
      logLevel: 'silent',
    })
    const { NODE_OPTIONS: _inherited, ...env } = process.env
    const { stdout } = await run(electronBinary, [probe, HISTORY_WORKER_SCRIPT], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(Number(stdout.trim())).toBeLessThan(1.1 * GIB)
  })

  it('keeps wide and combined characters through the worker', async () => {
    const client = startSpillWorker(HISTORY_WORKER_SCRIPT)
    clients.push(client)
    const history = makeHistory()
    const feed = client.open(history, 80, 24)
    feed.write('漢字 🙂 café\r\n')
    feed.write(numbered(0, SPILL_BATCH))
    await feed.close()
    expect((await plain(history))[0]).toBe('漢字 🙂 café')
  })

  it('posts output once the pane goes quiet, as one message, ahead of the next request', () => {
    vi.useFakeTimers()
    const { port, posted } = fakePort()
    const client = new SpillClient(port)
    const feed = client.open(makeHistory(), 80, 24)
    const written = () => writesOf(posted).map((r) => new TextDecoder().decode(r.data))
    feed.write('a')
    feed.write('b')
    feed.resize(100, 30)
    feed.write('c')
    vi.advanceTimersByTime(60)
    feed.write('d')
    vi.advanceTimersByTime(60)
    expect(written()).toEqual(['ab'])
    vi.advanceTimersByTime(60)
    expect(posted.map((r) => r.kind)).toEqual(['open', 'write', 'resize', 'write'])
    expect(written()).toEqual(['ab', 'cd'])
    client.end('test-done')
  })

  it('never holds more than a pane cap of unsent output and sends it in bounded slices', () => {
    const { port, posted } = fakePort()
    const client = new SpillClient(port)
    const { pressure, counts } = countingPressure(true)
    const feed = client.open(makeHistory(), 80, 24, pressure)
    const chunk = 'x'.repeat(64 * 1024)
    let written = 0
    for (let i = 0; i < 160; i++) {
      feed.write(chunk)
      written += chunk.length
      const sent = writesOf(posted).reduce((sum, r) => sum + r.chars, 0)
      expect(written - sent).toBeLessThan(PANE_SEND_CHARS)
    }
    expect(Math.max(...writesOf(posted).map((r) => r.chars))).toBeLessThanOrEqual(SLICE_CHARS)
    expect(counts.held).toBe(written)
    client.end('test-done')
  })

  it('releases held output only as the worker parses it, so a slow worker pauses the pty', () => {
    const { port, posted, answer } = fakePort()
    const client = new SpillClient(port)
    const { pressure, counts } = countingPressure(true)
    const feed = client.open(makeHistory(), 80, 24, pressure)
    for (let i = 0; i < 64; i++) feed.write('y'.repeat(64 * 1024))
    expect(counts.released).toBe(0)
    const [first] = writesOf(posted)
    answer({ kind: 'parsed', session: first.session, chars: first.chars })
    expect(counts.released).toBe(first.chars)
    client.end('test-done')
  })

  it('stops taking output a pane cannot pause for at the backlog bound, then resyncs from the screen once the worker caught up', () => {
    const { port, posted, answer } = fakePort()
    const client = new SpillClient(port)
    const feed = client.open(makeHistory(), 80, 24, countingPressure(false).pressure)
    feed.watchScreen(() => 'screen now')
    for (let i = 0; i < 800; i++) feed.write('z'.repeat(64 * 1024))
    feed.resize(81, 24)
    const sent = writesOf(posted).reduce((sum, r) => sum + r.chars, 0)
    expect(sent).toBeLessThanOrEqual(SPILL_BACKLOG.high)
    expect(posted.some((r) => r.kind === 'resync')).toBe(false)
    for (const write of writesOf(posted)) {
      answer({ kind: 'parsed', session: write.session, chars: write.chars })
    }
    expect(posted.filter((r) => r.kind === 'resync')).toEqual([
      { kind: 'resync', session: 0, screen: 'screen now' },
    ])
    client.end('test-done')
  })

  it('marks a gap only where lines were lost, and spills on after a resync without repeating the screen', async () => {
    const lines: string[] = []
    const sink: SpillSink = {
      get end() {
        return lines.length
      },
      live: true,
      append: (batch) => lines.push(...batch),
      blockStarted: () => undefined,
      blockEnded: () => undefined,
      wipe: () => undefined,
      flush: () => undefined,
    }
    const spill = new SpillTerminal(80, 24, sink, 0)
    const bytes = (text: string) => new TextEncoder().encode(text)
    spill.write(bytes(numbered(0, 3 * SPILL_BATCH)), () => undefined)
    spill.resync('screen 1\r\nscreen 2')
    spill.write(bytes(numbered(5000, 3 * SPILL_BATCH)), () => undefined)
    await spill.close()
    const plainLines = lines.map((l) => stripVTControlCharacters(l))
    expect(plainLines.filter((l) => l === stripVTControlCharacters(GAP_LINE))).toHaveLength(1)
    expect(plainLines.slice(0, 3 * SPILL_BATCH)).toEqual(
      Array.from({ length: 3 * SPILL_BATCH }, (_, i) => `out ${i}`),
    )
    expect(plainLines).not.toContain('screen 1')
    expect(plainLines.slice(-3 * SPILL_BATCH)).toEqual(
      Array.from({ length: 3 * SPILL_BATCH }, (_, i) => `out ${5000 + i}`),
    )
  })

  it('turns history off with the reason when the worker is gone, and answers what was asked', async () => {
    const client = spillInThread()
    const onFailed = vi.fn()
    const history = makeHistory(onFailed)
    const mirror = new ScreenMirror(80, 24, client.open(history, 80, 24))
    owned.push(mirror)
    const tail = mirror.historyTail()
    client.end('spill-worker-exited')
    expect(await tail).toEqual([])
    expect(onFailed).toHaveBeenCalledWith('spill-worker-exited')
    expect(history.live).toBe(false)
    expect(client.alive).toBe(false)
    mirror.write(numbered(0, 10))
    expect(await mirror.screenText(1)).toBe('out 9')
  })

  it('numbers a restarted shell after the lines its previous shell spilled on the way out', async () => {
    const client = spillInThread()
    const history = makeHistory()
    const first = client.open(history, 80, 24)
    first.write(numbered(0, 30))
    await first.close()
    const second = client.open(history, 80, 24)
    second.write(`${mark('C')}${numbered(30, 3)}${mark('D;0')}${mark('A')}$ `)
    await second.close()
    expect(await plain(history)).toEqual([
      ...Array.from({ length: 33 }, (_, i) => `out ${i}`),
      '$ ',
    ])
    expect(history.block(1)).toMatchObject({ start: 30, end: 33 })
  })

  it('takes the next shell its block numbers from the worker, counting a C mark main had not parsed yet', async () => {
    const histories = makeHistories()
    const mirror = new ScreenMirror(80, 24, histories.feedFor('p', 80, 24))
    mirror.write(`${mark('C')}out\r\n${mark('D;0')}${mark('A')}$ `)
    mirror.dispose()
    await histories.settled('p')
    const next = new ScreenMirror(80, 24, histories.feedFor('p', 80, 24))
    owned.push(next)
    expect(next.blockSeqBase).toBe(1)
  })

  it('decides a restart continues the history only after the old session closed, so its restore spills nothing twice', async () => {
    const histories = makeHistories()
    const first = new ScreenMirror(80, 24, histories.feedFor('p', 80, 24))
    first.write(numbered(0, 2 * SPILL_BATCH))
    await first.flush()
    const saved = first.serialize()
    first.dispose()
    await histories.settled('p')
    const feed = histories.feedFor('p', 80, 24)
    expect(feed?.continues).toBe(true)
    const second = new ScreenMirror(80, 24, feed)
    second.restore(saved)
    second.write(numbered(2 * SPILL_BATCH, 30))
    second.dispose()
    await histories.settled('p')
    const lines = await plain(histories.get('p') as PaneHistory)
    expect(lines.filter((l) => l.startsWith('out '))).toEqual(
      Array.from({ length: 2 * SPILL_BATCH + 30 }, (_, i) => `out ${i}`),
    )
  })
})
