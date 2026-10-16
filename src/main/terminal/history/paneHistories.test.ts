import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { spillInThread } from '../../../../test/historySpill'
import type { ScrollbackHistory } from '../../../shared/terminal/scrollbackHistory'
import { FREE_SPACE_FLOOR, PaneHistories, sweepHistoryRoot } from './paneHistories'

const made: PaneHistories[] = []

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

afterEach(() => {
  for (const store of made.splice(0)) store.removeAll()
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
    history?.append(['a'])
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
    one?.append(['a'])
    two?.append(['b'])
    await Promise.all([one?.flush(), two?.flush()])
    const [run] = readdirSync(root)
    store.drop('p1')
    expect(readdirSync(join(root, run))).toHaveLength(1)
    store.removeAll()
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
      big.append([`${'x'.repeat(1000)} ${i}`])
      await big.flush()
    }
    expect(big.droppable).toBe(true)
    low = true
    small.append(['y'])
    await small.flush()
    expect(big.live).toBe(true)
    expect(big.first).toBe(1)
    expect(small.live).toBe(true)
    expect(await small.read(0, 1)).toEqual(['y'])
  })

  it('turns a pane off when no pane can give up space', async () => {
    const { store } = histories('unlimited', () => 0)
    const only = store.forPane('only')
    only?.append(['y'])
    await only?.flush()
    expect(only?.live).toBe(false)
  })
})
