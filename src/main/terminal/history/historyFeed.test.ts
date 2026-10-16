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
import { type SpillClient, startSpillWorker } from './historyFeed'
import { newHistoryKey } from './historyRecords'
import { SPILL_BATCH } from './historySpill'
import { PaneHistory } from './paneHistory'

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
