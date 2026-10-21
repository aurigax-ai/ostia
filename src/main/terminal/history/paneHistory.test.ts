import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { put } from '../../../../test/historySpill'
import { newHistoryKey, openLines, sealLines } from './historyRecords'
import { PaneHistory, RECORD_BYTES } from './paneHistory'

const opening = vi.hoisted(() => ({ hold: null as Promise<void> | null, entered: () => {} }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const hold = opening.hold
      if (hold) {
        opening.entered()
        await hold
      }
      return actual.open(...args)
    },
  }
})

const histories: PaneHistory[] = []

function makeHistory(overrides: Partial<ConstructorParameters<typeof PaneHistory>[0]> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pane-history-'))
  const dir = join(root, 'pane')
  const history = new PaneHistory({
    dir,
    key: newHistoryKey(),
    limitBytes: () => null,
    ensureSpace: async () => true,
    onFailed: vi.fn(),
    ...overrides,
  })
  histories.push(history)
  return { history, dir }
}

const numbered = (from: number, count: number, text = 'line'): string[] =>
  Array.from({ length: count }, (_, i) => `${text} ${from + i}`)

afterEach(async () => {
  opening.hold = null
  await Promise.all(histories.splice(0).map((history) => history.dispose()))
})

describe('history records', () => {
  it('round-trips lines and refuses another key', async () => {
    const key = newHistoryKey()
    const sealed = await sealLines(key, ['one', '\x1b[31mtwo\x1b[0m', ''])
    expect(sealed.includes(Buffer.from('one'))).toBe(false)
    expect(await openLines(key, sealed)).toEqual(['one', '\x1b[31mtwo\x1b[0m', ''])
    await expect(openLines(newHistoryKey(), sealed)).rejects.toThrow()
  })
})

describe('PaneHistory', () => {
  it('reads back what was appended, written or still pending, in order', async () => {
    const { history } = makeHistory()
    put(history, numbered(0, 3000))
    await history.flush()
    put(history, numbered(3000, 10))
    expect(history.end).toBe(3010)
    expect(await history.read(2995, 10)).toEqual(numbered(2995, 10))
    expect(await history.read(0, 2)).toEqual(numbered(0, 2))
    expect(await history.read(3008, 100)).toEqual(numbered(3008, 2))
  })

  it('reads back pending batches line by line, empty lines and one-line batches included', async () => {
    const { history } = makeHistory()
    put(history, ['first', '', 'third'])
    put(history, [''])
    put(history, ['\x1b[31mred\x1b[0m'])
    expect(history.end).toBe(5)
    expect(await history.read(0, 5)).toEqual(['first', '', 'third', '', '\x1b[31mred\x1b[0m'])
    expect(await history.read(2, 2)).toEqual(['third', ''])
    await history.flush()
    expect(await history.read(0, 5)).toEqual(['first', '', 'third', '', '\x1b[31mred\x1b[0m'])
  })

  it('keeps nothing readable on disk: a 0700 folder, 0600 files, no plaintext', async () => {
    const { history, dir } = makeHistory()
    put(history, numbered(0, 50, 'secret-looking text'))
    await history.flush()
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const file = join(dir, files[0])
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file).includes(Buffer.from('secret-looking'))).toBe(false)
  })

  it('writes a record once enough text is pending, without waiting for the idle flush', async () => {
    const { history, dir } = makeHistory()
    put(history, ['x'.repeat(RECORD_BYTES)])
    await vi.waitFor(() => expect(existsSync(dir) && readdirSync(dir).length).toBe(1))
  })

  it('drops the oldest segment past the cap and moves the first line', async () => {
    const { history, dir } = makeHistory({ limitBytes: () => 1, segmentBytes: 1 })
    put(history, numbered(0, 100))
    await history.flush()
    history.blockStarted(1, 10, 'make')
    put(history, numbered(100, 100))
    await history.flush()
    put(history, numbered(200, 100))
    await history.flush()
    expect(history.first).toBe(200)
    await vi.waitFor(() => expect(readdirSync(dir)).toHaveLength(1))
    expect(await history.read(0, 300)).toEqual(numbered(200, 100))
    expect(history.block(1)).toBeUndefined()
  })

  it('records blocks and finds them by sequence number', () => {
    const { history } = makeHistory()
    put(history, numbered(0, 5))
    history.blockStarted(7, 1, 'ls')
    history.blockEnded(7, 4, 3, 2, null)
    expect(history.block(7)).toEqual({
      seq: 7,
      start: 1,
      end: 4,
      endCol: 3,
      exitCode: 2,
      command: 'ls',
    })
  })

  it('wipes every line, block and file but keeps counting lines', async () => {
    const { history, dir } = makeHistory()
    put(history, numbered(0, 100))
    history.blockStarted(1, 2, 'cat')
    await history.flush()
    history.wipe()
    await history.flush()
    expect(history.first).toBe(100)
    expect(await history.read(0, 100)).toEqual([])
    expect(history.block(1)).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
    put(history, ['after'])
    expect(await history.read(100, 1)).toEqual(['after'])
  })

  it('turns itself off when it cannot make room, and reports why', async () => {
    const onFailed = vi.fn()
    const { history } = makeHistory({ ensureSpace: async () => false, onFailed })
    put(history, numbered(0, 3))
    await history.flush()
    expect(onFailed).toHaveBeenCalledWith('disk-full')
    expect(history.live).toBe(false)
    put(history, ['ignored'])
    expect(await history.read(0, 10)).toEqual([])
  })

  it('removes its folder when disposed', async () => {
    const { history, dir } = makeHistory()
    put(history, numbered(0, 3))
    await history.flush()
    await history.dispose()
    expect(existsSync(dir)).toBe(false)
  })

  it('removes its folder only after a write that is opening its segment finishes', async () => {
    const onFailed = vi.fn()
    const { history, dir } = makeHistory({ onFailed })
    let release = () => {}
    opening.hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const entered = new Promise<void>((resolve) => {
      opening.entered = resolve
    })
    put(history, numbered(0, 3))
    void history.flush()
    await entered
    const disposed = history.dispose()
    expect(existsSync(dir)).toBe(true)
    release()
    await disposed
    expect(onFailed).not.toHaveBeenCalled()
    expect(existsSync(dir)).toBe(false)
  })
})
