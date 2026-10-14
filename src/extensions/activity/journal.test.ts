import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ActivityEvent } from './hookEvent'
import { JOURNAL_DIR, JOURNAL_MAX_AGE_MS, Journal } from './journal'

const DAY = 24 * 60 * 60 * 1000

function event(t: number, text = 'pnpm test'): ActivityEvent {
  return {
    v: 1,
    t,
    pane: 'pane-1',
    agent: 'claude',
    session: 's-1',
    kind: 'tool',
    tool: 'command',
    text,
  }
}

describe('Journal', () => {
  let dir: string
  let now: number
  const journal = (maxBytes?: number): Journal =>
    new Journal({ dir, now: () => now, ...(maxBytes ? { maxBytes } : {}) })
  const file = (workspaceId: string): string => join(dir, JOURNAL_DIR, `${workspaceId}.jsonl`)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-activity-journal-'))
    now = 100 * DAY
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('appends one JSON line per event to a 0600 file in a 0700 folder and reads it back after a restart', () => {
    const first = journal()
    first.append('w1', event(now - 2000, 'pnpm lint'), true)
    first.append('w1', event(now - 1000), true)
    expect(statSync(file('w1')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, JOURNAL_DIR)).mode & 0o777).toBe(0o700)
    expect(
      readFileSync(file('w1'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l)),
    ).toEqual([event(now - 2000, 'pnpm lint'), event(now - 1000)])
    const second = journal()
    second.load()
    expect(second.events('w1')).toEqual([event(now - 2000, 'pnpm lint'), event(now - 1000)])
    expect(second.keepsOnDisk('w1')).toBe(true)
  })

  it('drops the oldest events when a workspace passes the size cap and stays 0600', () => {
    const capped = journal(2000)
    for (let i = 0; i < 100; i++) capped.append('w1', event(now - 1000 + i, `step ${i}`), true)
    const kept = capped.events('w1')
    expect(kept.length).toBeLessThan(100)
    expect(kept.at(-1)).toEqual(event(now - 901, 'step 99'))
    expect(statSync(file('w1')).size).toBeLessThanOrEqual(2000)
    expect(statSync(file('w1')).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(dir, JOURNAL_DIR))).toEqual(['w1.jsonl'])
    const reloaded = journal(2000)
    reloaded.load()
    expect(reloaded.events('w1')).toEqual(kept)
  })

  it('forgets events older than the age cap on load and on prune, and removes an emptied file', () => {
    const first = journal()
    first.append('w1', event(now - JOURNAL_MAX_AGE_MS - 5), true)
    first.append('w1', event(now - 5, 'recent'), true)
    first.append('w2', event(now - 5, 'only'), true)
    now += 10
    const second = journal()
    second.load()
    expect(second.events('w1')).toEqual([event(now - 15, 'recent')])
    expect(readFileSync(file('w1'), 'utf8')).not.toContain('pnpm test')
    now += JOURNAL_MAX_AGE_MS
    expect(second.prune()).toBe(true)
    expect(second.workspaceIds()).toEqual([])
    expect(existsSync(file('w1'))).toBe(false)
    expect(existsSync(file('w2'))).toBe(false)
    expect(second.prune()).toBe(false)
  })

  it('keeps a memory-only workspace off the disk and drops it once the workspace is closed', () => {
    const memory = journal()
    memory.append('scratch-1', event(now), false)
    memory.append('w1', event(now), true)
    expect(memory.events('scratch-1')).toEqual([event(now)])
    expect(readdirSync(join(dir, JOURNAL_DIR))).toEqual(['w1.jsonl'])
    expect(memory.dropClosedMemory(new Set(['scratch-1', 'w1']))).toBe(false)
    expect(memory.dropClosedMemory(new Set())).toBe(true)
    expect(memory.events('scratch-1')).toEqual([])
    expect(memory.events('w1')).toEqual([event(now)])
    const reloaded = journal()
    reloaded.load()
    expect(reloaded.workspaceIds()).toEqual(['w1'])
  })

  it('removes the file when a stored workspace turns memory-only', () => {
    const turning = journal()
    turning.append('w1', event(now - 1), true)
    turning.append('w1', event(now), false)
    expect(existsSync(file('w1'))).toBe(false)
    expect(turning.events('w1')).toHaveLength(2)
    turning.append('w1', event(now + 1), true)
    expect(existsSync(file('w1'))).toBe(false)
  })

  it('never writes outside its folder, through a symlink, or lines it did not write itself', () => {
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'untouched')
    mkdirSync(join(dir, JOURNAL_DIR))
    symlinkSync(outside, file('w1'))
    writeFileSync(file('w2'), `${JSON.stringify(event(now - 1))}\nnot json\n{"v":9}\n`)
    const guarded = journal()
    guarded.load()
    expect(guarded.events('w1')).toEqual([])
    expect(guarded.events('w2')).toEqual([event(now - 1)])
    expect(readFileSync(file('w2'), 'utf8')).toBe(`${JSON.stringify(event(now - 1))}\n`)
    guarded.append('w1', event(now), true)
    guarded.append('../escape', event(now), true)
    expect(readFileSync(outside, 'utf8')).toBe('untouched')
    expect(guarded.keepsOnDisk('w1')).toBe(false)
    expect(guarded.keepsOnDisk('../escape')).toBe(false)
    expect(existsSync(join(dir, 'escape.jsonl'))).toBe(false)
  })

  it('keeps everything in memory when it has no data folder', () => {
    const homeless = new Journal({ dir: null, now: () => now })
    homeless.load()
    homeless.append('w1', event(now), true)
    expect(homeless.events('w1')).toEqual([event(now)])
    expect(homeless.keepsOnDisk('w1')).toBe(false)
  })
})
