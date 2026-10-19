import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { put, spillInThread } from '../../../../test/historySpill'
import type { ScrollbackHistory } from '../../../shared/terminal/scrollbackHistory'
import { FREE_SPACE_FLOOR, PaneHistories, removeHistories, sweepHistoryRoot } from './paneHistories'

const opening = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  entered: () => {},
  events: [] as string[],
}))

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
      const handle = await actual.open(...args)
      opening.events.push('opened')
      return handle
    },
    rm: (...args: Parameters<typeof actual.rm>) => {
      opening.events.push(`rm ${String(args[0])}`)
      return actual.rm(...args)
    },
  }
})

const made: PaneHistories[] = []

function holdNextOpen() {
  opening.events = []
  let release = () => {}
  opening.hold = new Promise<void>((resolve) => {
    release = resolve
  })
  const entered = new Promise<void>((resolve) => {
    opening.entered = resolve
  })
  return { release, entered }
}

function histories(setting: ScrollbackHistory = 'unlimited', free = () => FREE_SPACE_FLOOR * 2) {
  const root = mkdtempSync(join(tmpdir(), 'histories-'))
  const store = new PaneHistories({
    root,
    setting: () => setting,
    startSpill: spillInThread,
    freeBytes: async () => free(),
  })
  made.push(store)
  return { store, root }
}

const deadPid = 2 ** 22 + 7

afterEach(async () => {
  opening.hold = null
  for (const store of made.splice(0)) await store.removeAll()
})

describe('PaneHistories', () => {
  it('sweeps folders of runs whose process is gone and keeps live ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-'))
    mkdirSync(join(root, `${deadPid}-abcd`))
    mkdirSync(join(root, `${process.ppid}-abcd`))
    mkdirSync(join(root, 'stray'))
    sweepHistoryRoot(root, -1)
    expect(readdirSync(root)).toEqual([`${process.ppid}-abcd`])
    expect(statSync(root).mode & 0o777).toBe(0o700)
  })

  it('keeps no history when the setting is off', () => {
    expect(histories('off').store.forPane('p1')).toBeNull()
  })

  it('gives each pane its own folder under this run, named without the pane id', async () => {
    const { store, root } = histories()
    const history = store.forPane('p1')
    put(history, ['a'])
    await history?.flush()
    const [run] = readdirSync(root)
    expect(run).toMatch(new RegExp(`^${process.pid}-`))
    const [folder] = readdirSync(join(root, run))
    expect(folder).not.toContain('p1')
    expect(store.forPane('p1')).toBe(history)
  })

  it('drops a pane folder on close and the run folder on quit', async () => {
    const { store, root } = histories()
    const one = store.forPane('p1')
    const two = store.forPane('p2')
    put(one, ['a'])
    put(two, ['b'])
    await Promise.all([one?.flush(), two?.flush()])
    const [run] = readdirSync(root)
    store.drop('p1')
    await store.removeAll()
    expect(existsSync(join(root, run))).toBe(false)
  })

  it('frees space from the largest pane first when the disk runs low', async () => {
    const root = mkdtempSync(join(tmpdir(), 'histories-'))
    let big: ReturnType<PaneHistories['forPane']> = null
    let low = false
    const store = new PaneHistories({
      root,
      setting: () => 'unlimited',
      startSpill: spillInThread,
      segmentBytes: 1,
      freeBytes: async () => (low && big?.first === 0 ? 0 : FREE_SPACE_FLOOR),
    })
    made.push(store)
    big = store.forPane('big')
    const small = store.forPane('small')
    if (!big || !small) throw new Error('no history')
    for (let i = 0; i < 3; i++) {
      put(big, [`${'x'.repeat(1000)} ${i}`])
      await big.flush()
    }
    expect(big.droppable).toBe(true)
    low = true
    put(small, ['y'])
    await small.flush()
    expect(big.live).toBe(true)
    expect(big.first).toBe(1)
    expect(small.live).toBe(true)
    expect(await small.read(0, 1)).toEqual(['y'])
  })

  it('turns a pane off when no pane can give up space', async () => {
    const { store } = histories('unlimited', () => 0)
    const only = store.forPane('only')
    put(only, ['y'])
    await only?.flush()
    expect(only?.live).toBe(false)
  })

  it.each([
    ['a pane closed just before quit', (store: PaneHistories) => store.drop('p1')],
    [
      'a failed history replaced for its pane',
      (store: PaneHistories) => {
        const failed = store.get('p1')
        failed?.fail('test')
        store.forPane('p1')
      },
    ],
  ])('quit waits for the pending segment write of %s', async (_name, retire) => {
    const { store, root } = histories()
    const history = store.forPane('p1')
    const { release, entered } = holdNextOpen()
    put(history, ['a'])
    void history?.flush()
    await entered
    retire(store)
    const runDir = join(root, readdirSync(root)[0])
    const removing = store.removeAll()
    release()
    await removing
    expect(opening.events.indexOf('opened')).toBeLessThan(opening.events.indexOf(`rm ${runDir}`))
    expect(readdirSync(root)).toHaveLength(0)
  })

  it('logs a run folder it cannot remove and lets quit carry on', async () => {
    const warn = vi.fn()
    const stuck = {
      removeAll: () => Promise.reject(Object.assign(new Error('x'), { code: 'EBUSY' })),
    }
    await removeHistories(stuck as unknown as PaneHistories, { warn } as never)
    expect(warn).toHaveBeenCalledWith('history-remove-failed', { code: 'EBUSY' })
  })
})
