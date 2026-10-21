import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ARCHIVE_DIR } from './archive'
import type { ActivityEvent, ActivityNote } from './hookEvent'
import { DAY_MS, JOURNAL_DIR, Journal, RETENTION_DAYS } from './journal'

const DAY = DAY_MS
const LIVE_MS = RETENTION_DAYS * DAY

function event(t: number, text = 'pnpm test'): ActivityEvent {
  return {
    v: 2,
    t,
    id: 'aaaaaaaaaa',
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

  it('moves events older than the live window to the archive on load and on prune, and removes an emptied file', () => {
    const first = journal()
    first.append('w1', event(now - LIVE_MS - 5), true)
    first.append('w1', event(now - 5, 'recent'), true)
    first.append('w2', event(now - 5, 'only'), true)
    now += 10
    const second = journal()
    second.load()
    expect(second.events('w1')).toEqual([event(now - 15, 'recent')])
    expect(readFileSync(file('w1'), 'utf8')).not.toContain('pnpm test')
    expect(second.archived('w1')).toEqual([event(now - LIVE_MS - 15)])
    now += LIVE_MS
    expect(second.prune()).toBe(true)
    expect(second.workspaceIds()).toEqual([])
    expect(existsSync(file('w1'))).toBe(false)
    expect(existsSync(file('w2'))).toBe(false)
    expect(second.archived('w1').map((e) => ('text' in e ? e.text : undefined))).toEqual([
      'pnpm test',
      'recent',
    ])
    expect(second.archived('w2').map((e) => ('text' in e ? e.text : undefined))).toEqual(['only'])
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

  const note = (t: number, id: string, extra: Partial<ActivityNote> = {}): ActivityNote => ({
    v: 2,
    t,
    id,
    pane: 'pane-1',
    kind: 'note',
    text: `note ${id}`,
    ...extra,
  })
  const archiveFiles = (workspaceId: string): string[] =>
    readdirSync(join(dir, ARCHIVE_DIR, workspaceId)).sort()

  it('never ages out an open needs-you item, and archives it once it is done', () => {
    const first = journal()
    first.append('w1', note(now - LIVE_MS - 50, 'opennnnnnn', { needsYou: true }), true)
    first.append('w1', note(now - LIVE_MS - 40, 'plainnnnnn'), true)
    now += 3 * LIVE_MS
    const second = journal()
    second.load()
    expect(second.events('w1').map((r) => r.id)).toEqual(['opennnnnnn'])
    expect(second.openNeedsYou('w1').map((r) => r.id)).toEqual(['opennnnnnn'])
    expect(second.prune()).toBe(false)
    expect(second.markDone('w1', 'opennnnnnn', now)).toMatchObject({ doneAt: now })
    const third = journal()
    third.load()
    expect(third.events('w1')).toEqual([])
    expect(third.find('w1', 'opennnnnnn')).toMatchObject({ doneAt: now })
    expect(third.archived('w1').map((r) => r.id)).toEqual(['plainnnnnn', 'opennnnnnn'])
  })

  it('marks only a needs-you note done, keeps the mark across a restart and leaves the file 0600', () => {
    const marking = journal()
    marking.append('w1', note(now, 'needsyouaa', { needsYou: true }), true)
    marking.append('w1', note(now, 'plainaaaaa'), true)
    expect(marking.markDone('w1', 'plainaaaaa', now)).toBeNull()
    expect(marking.markDone('w1', 'nosuchaaaa', now)).toBeNull()
    expect(marking.markDone('w1', 'needsyouaa', now + 5)).toMatchObject({ doneAt: now + 5 })
    expect(marking.markDone('w1', 'needsyouaa', now + 9)).toMatchObject({ doneAt: now + 5 })
    expect(statSync(file('w1')).mode & 0o777).toBe(0o600)
    const reloaded = journal()
    reloaded.load()
    expect(reloaded.openNeedsYou('w1')).toEqual([])
    expect(reloaded.find('w1', 'needsyouaa')).toMatchObject({ doneAt: now + 5 })
  })

  it('moves what the size cap trims to the archive and never trims an open needs-you item', () => {
    const capped = journal(2000)
    capped.append('w1', note(now - 2000, 'keepmeaaaa', { needsYou: true }), true)
    for (let i = 0; i < 60; i++) capped.append('w1', event(now - 1000 + i, `step ${i}`), true)
    expect(capped.events('w1')[0]?.id).toBe('keepmeaaaa')
    expect(capped.events('w1').length).toBeLessThan(61)
    const archived = capped.archived('w1')
    expect(archived.length).toBeGreaterThan(0)
    expect(archived.length + capped.events('w1').length).toBe(61)
    expect(archived.some((r) => r.id === 'keepmeaaaa')).toBe(false)
  })

  it('keeps the archive per workspace and month, gzip and 0600, and deletes it after the archive window or past its size limit', () => {
    const at = Date.UTC(2026, 0, 20)
    now = at
    const archiving = new Journal({
      dir,
      now: () => now,
      retention: { liveMs: DAY, archiveMs: 60 * DAY },
      archiveMaxBytes: 1_000_000,
    })
    archiving.append('w1', event(Date.UTC(2025, 11, 30), 'december'), true)
    archiving.append('w1', event(Date.UTC(2026, 0, 2), 'january'), true)
    archiving.append('w1', event(at, 'today'), true)
    archiving.prune()
    expect(archiveFiles('w1')).toEqual(['2025-12.jsonl.gz', '2026-01.jsonl.gz'])
    const month = join(dir, ARCHIVE_DIR, 'w1', '2026-01.jsonl.gz')
    expect(statSync(month).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, ARCHIVE_DIR, 'w1')).mode & 0o777).toBe(0o700)
    expect(readFileSync(month).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]))
    expect(archiving.archived('w1').map((e) => ('text' in e ? e.text : undefined))).toEqual([
      'december',
      'january',
    ])
    now = Date.UTC(2026, 2, 5)
    archiving.prune()
    expect(archiveFiles('w1')).toEqual(['2026-01.jsonl.gz'])
    const small = new Journal({
      dir,
      now: () => now,
      retention: { liveMs: DAY, archiveMs: 60 * DAY },
      archiveMaxBytes: 10,
    })
    small.prune()
    expect(existsSync(join(dir, ARCHIVE_DIR, 'w1'))).toBe(false)
  })

  it('writes no archive for a memory-only workspace', () => {
    const memory = journal()
    memory.append('scratch-1', event(now - LIVE_MS - 5), false)
    memory.append('scratch-1', note(now - LIVE_MS - 5, 'scratchaaa', { needsYou: true }), false)
    expect(memory.prune()).toBe(true)
    expect(memory.events('scratch-1').map((r) => r.id)).toEqual(['scratchaaa'])
    expect(memory.archived('scratch-1')).toEqual([])
    expect(existsSync(join(dir, ARCHIVE_DIR))).toBe(false)
  })

  it('bumps a workspace revision on every change to it and on nothing else', () => {
    const tracked = journal()
    expect(tracked.revision('w1')).toBe(0)
    tracked.append('w1', note(now, 'needsyouaa', { needsYou: true }), true)
    const afterAppend = tracked.revision('w1')
    expect(afterAppend).toBeGreaterThan(0)
    expect(tracked.revision('w2')).toBe(0)

    expect(tracked.markDone('w1', 'nosuchaaaa', now)).toBeNull()
    expect(tracked.revision('w1')).toBe(afterAppend)
    tracked.markDone('w1', 'needsyouaa', now)
    const afterDone = tracked.revision('w1')
    expect(afterDone).toBeGreaterThan(afterAppend)
    tracked.markDone('w1', 'needsyouaa', now + 5)
    expect(tracked.revision('w1')).toBe(afterDone)

    tracked.append('w2', event(now - LIVE_MS - 5), true)
    const other = tracked.revision('w2')
    expect(tracked.prune()).toBe(true)
    expect(tracked.revision('w2')).toBeGreaterThan(other)
    expect(tracked.revision('w1')).toBe(afterDone)
  })

  it('bumps the revision of a memory-only workspace that is dropped once it is closed', () => {
    const memory = journal()
    memory.append('scratch-1', event(now), false)
    const before = memory.revision('scratch-1')
    expect(memory.dropClosedMemory(new Set())).toBe(true)
    expect(memory.revision('scratch-1')).toBeGreaterThan(before)
  })
})
