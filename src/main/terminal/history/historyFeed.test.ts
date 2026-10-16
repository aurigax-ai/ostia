import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HISTORY_WORKER_SCRIPT,
  closeSpillChannels,
  spillInThread,
} from '../../../../test/historySpill'
import { ScreenMirror } from '../screenMirror'
import { SpillClient, type SpillPort, spillWorker, startSpillWorker } from './historyFeed'
import { newHistoryKey } from './historyRecords'
import { SPILL_BATCH } from './historySpill'
import { PaneHistory } from './paneHistory'
import type { SpillRequest } from './spillHost'

const ESC = '\x1b'
const mark = (kind: string) => `${ESC}]133;${kind}\x07`
const owned: { dispose(): void }[] = []
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

const numbered = (from: number, count: number): string =>
  Array.from({ length: count }, (_, i) => `out ${from + i}\r\n`).join('')

async function plain(history: PaneHistory): Promise<string[]> {
  return (await history.read(history.first, history.end - history.first)).map((l) =>
    stripVTControlCharacters(l),
  )
}

afterEach(() => {
  for (const item of owned.splice(0).reverse()) item.dispose()
  for (const client of clients.splice(0)) client.end('test-done')
  closeSpillChannels()
})

describe('history feed', () => {
  it('spills through the built worker', async () => {
    const client = startSpillWorker(HISTORY_WORKER_SCRIPT)
    clients.push(client)
    const history = makeHistory()
    const feed = client.open(history, 80, 24)
    feed.write(numbered(0, 3 * SPILL_BATCH))
    await feed.close(0)
    expect(await plain(history)).toEqual(
      Array.from({ length: 3 * SPILL_BATCH }, (_, i) => `out ${i}`),
    )
  })

  it('keeps the worker heap small after a burst of output across panes', async () => {
    const worker = spillWorker(HISTORY_WORKER_SCRIPT)
    owned.push({ dispose: () => void worker.terminate() })
    const client = new SpillClient(worker as unknown as SpillPort)
    const feeds = Array.from({ length: 10 }, () => client.open(makeHistory(), 160, 24))
    let peak = 0
    for (let round = 0; round < 40; round++) {
      for (const feed of feeds) feed.write(`${'x'.repeat(150)}\r\n`.repeat(SPILL_BATCH))
      await Promise.all(feeds.map((feed) => feed.tail()))
      peak = Math.max(peak, (await worker.getHeapStatistics()).total_heap_size)
    }
    await Promise.all(feeds.map((feed) => feed.close(0)))
    expect(peak).toBeLessThan(96 * 1024 * 1024)
  })

  it('keeps wide and combined characters through the worker', async () => {
    const client = startSpillWorker(HISTORY_WORKER_SCRIPT)
    clients.push(client)
    const history = makeHistory()
    const feed = client.open(history, 80, 24)
    feed.write('漢字 🙂 café\r\n')
    feed.write(numbered(0, SPILL_BATCH))
    await feed.close(0)
    expect((await plain(history))[0]).toBe('漢字 🙂 café')
  })

  it('posts output once the pane goes quiet, as one message, ahead of the next request', async () => {
    vi.useFakeTimers()
    const posted: SpillRequest[] = []
    const client = new SpillClient({
      postMessage: (request) => posted.push(request),
      on: () => undefined,
    })
    const feed = client.open(makeHistory(), 80, 24)
    const written = () =>
      posted.filter((r) => r.kind === 'write').map((r) => new TextDecoder().decode(r.data))
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
    vi.useRealTimers()
  })

  it('posts at once when a burst passes the size cap, so main never holds more', () => {
    const posted: SpillRequest[] = []
    const client = new SpillClient({
      postMessage: (request) => posted.push(request),
      on: () => undefined,
    })
    const feed = client.open(makeHistory(), 80, 24)
    const chunk = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 32; i++) feed.write(chunk)
    const writes = posted.filter((r) => r.kind === 'write')
    expect(writes.map((r) => r.data.length)).toEqual([32 * chunk.length])
    client.end('test-done')
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
    const firstClosed = first.close(0)
    const second = client.open(history, 80, 24)
    second.write(`${mark('C')}${numbered(30, 3)}${mark('D;0')}${mark('A')}$ `)
    await firstClosed
    await second.close(1)
    expect(await plain(history)).toEqual([...Array.from({ length: 33 }, (_, i) => `out ${i}`), '$'])
    expect(history.block(1)).toMatchObject({ start: 30, end: 33 })
  })
})
