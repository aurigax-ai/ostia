import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SIGNAL_RETENTION_MS, type SignalDraft } from './signal'
import { SIGNALS_FILE, SignalStore } from './signalStore'

const DAY = 24 * 60 * 60 * 1000

function draft(extra: Partial<SignalDraft> = {}): SignalDraft {
  return {
    at: 100 * DAY,
    kind: 'prompt',
    agent: 'claude',
    text: 'never add comments',
    session: 's',
    pane: 'p',
    workspace: 'w',
    project: null,
    stacks: [],
    ...extra,
  }
}

describe('SignalStore', () => {
  let dir: string
  let clock: number
  const file = () => join(dir, SIGNALS_FILE)
  const open = (maxBytes?: number) => new SignalStore(dir, () => clock, maxBytes)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-signal-store-'))
    clock = 100 * DAY
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps what it stored across a restart, newest first, with ids that continue', () => {
    const store = open()
    store.add(draft({ text: 'one' }))
    store.add(draft({ text: 'two' }))
    const again = open()
    expect(again.list().map((s) => [s.id, s.text])).toEqual([
      ['s2', 'two'],
      ['s1', 'one'],
    ])
    expect(again.add(draft({ text: 'three' })).id).toBe('s3')
    expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('drops a signal older than 30 days when it opens and when it lists', () => {
    const store = open()
    store.add(draft({ at: clock - SIGNAL_RETENTION_MS - 1, text: 'old' }))
    store.add(draft({ at: clock - SIGNAL_RETENTION_MS, text: 'edge' }))
    store.add(draft({ text: 'new' }))
    expect(
      open()
        .list()
        .map((s) => s.text),
    ).toEqual(['new', 'edge'])
    clock += DAY
    expect(store.list().map((s) => s.text)).toEqual(['new'])
    expect(readFileSync(file(), 'utf8')).not.toContain('edge')
  })

  it('drops the oldest signals to stay under the size cap', () => {
    const line = JSON.stringify({ ...draft({ text: 'x'.repeat(100) }), id: 's1' }).length + 1
    const store = open(line * 3)
    for (let i = 0; i < 5; i++) store.add(draft({ text: `${i}`.repeat(100) }))
    expect(store.list().map((s) => s.id)).toEqual(['s5', 's4', 's3'])
    expect(readFileSync(file(), 'utf8').split('\n').filter(Boolean)).toHaveLength(3)
  })

  it('skips a damaged line and cleans it out of the file', () => {
    open().add(draft({ text: 'kept' }))
    appendFileSync(file(), 'not json\n{"id":"s9"}\n')
    const store = open()
    expect(store.list().map((s) => s.text)).toEqual(['kept'])
    expect(readFileSync(file(), 'utf8')).not.toContain('not json')
  })

  it('removes one signal and clears the file', () => {
    const store = open()
    store.add(draft({ text: 'one' }))
    store.add(draft({ text: 'two' }))
    expect(store.remove('s1')).toBe(true)
    expect(store.remove('s1')).toBe(false)
    expect(
      open()
        .list()
        .map((s) => s.text),
    ).toEqual(['two'])
    store.clear()
    expect(store.list()).toEqual([])
    expect(() => statSync(file())).toThrow()
  })

  it('opens an empty folder and an empty file without error', () => {
    writeFileSync(file(), '')
    expect(open().list()).toEqual([])
  })

  it('works in memory only when it has no folder', () => {
    const store = new SignalStore(null, () => clock)
    store.add(draft({ text: 'one' }))
    expect(store.list().map((s) => s.text)).toEqual(['one'])
  })
})
