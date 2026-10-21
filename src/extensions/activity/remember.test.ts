import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { newRecordId } from './hookEvent'
import { REMEMBER_DIR, RememberStore } from './remember'
import { isExpired, parseRememberItem, type RememberItem, startOf } from './rememberItem'

const DAY = 86_400_000
const NOW = Date.UTC(2026, 9, 14, 12)

function item(extra: Partial<RememberItem> = {}): RememberItem {
  return {
    v: 1,
    id: newRecordId(),
    t: NOW,
    pane: 'p1',
    session: 's1',
    agent: 'claude',
    text: 'Bisect fixture order',
    state: 'open',
    ...extra,
  }
}

describe('remember store', () => {
  let dir: string
  let now: number
  const store = () => new RememberStore({ dir, now: () => now })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-remember-'))
    now = NOW
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps items in a 0600 file per workspace that a new store reads back', () => {
    const first = store()
    const one = item()
    first.add('w1', one, true)
    const file = join(dir, REMEMBER_DIR, 'w1.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, REMEMBER_DIR)).mode & 0o777).toBe(0o700)
    const second = store()
    second.load()
    expect(second.items('w1')).toEqual([one])
  })

  it('keeps a memory-only workspace off the disk and removes a file it once had', () => {
    const s = store()
    s.add('sc1', item(), false)
    expect(readdirSync(join(dir)).includes(REMEMBER_DIR)).toBe(false)
    const disk = store()
    disk.add('w1', item(), true)
    disk.add('w1', item(), false)
    expect(readdirSync(join(dir, REMEMBER_DIR))).toEqual([])
  })

  it('moves done and restored items between states and counts only open ones', () => {
    const s = store()
    const a = item()
    const b = item({ text: 'Rename flags' })
    s.add('w1', a, true)
    s.add('w1', b, true)
    expect(s.openCount('w1')).toBe(2)
    expect(s.setState('w1', a.id, 'done', NOW + 5)?.doneAt).toBe(NOW + 5)
    expect(s.openCount('w1')).toBe(1)
    const restored = s.setState('w1', a.id, 'open', NOW + 9)
    expect(restored?.state).toBe('open')
    expect(restored?.doneAt).toBeUndefined()
    expect(restored?.restoredAt).toBe(NOW + 9)
    expect(s.setState('w1', 'nope000000', 'done', NOW)).toBeNull()
  })

  it('counts a restored item from its restore time', () => {
    const old = item({ t: NOW - 20 * DAY, restoredAt: NOW - DAY })
    expect(startOf(old)).toBe(NOW - DAY)
    expect(isExpired(old, NOW, 14)).toBe(false)
    expect(isExpired(item({ t: NOW - 14 * DAY }), NOW, 14)).toBe(true)
  })

  it('archives open items at their lifetime, never deletes them and leaves done ones alone', () => {
    const s = store()
    const fresh = item({ t: NOW - DAY })
    const stale = item({ t: NOW - 15 * DAY, text: 'old task' })
    const done = item({ t: NOW - 30 * DAY, state: 'done', doneAt: NOW - 29 * DAY })
    for (const i of [fresh, stale, done]) s.add('w1', i, true)
    expect(s.expire(NOW, 14)).toBe(true)
    const states = Object.fromEntries(s.items('w1').map((i) => [i.id, i.state]))
    expect(states).toEqual({ [fresh.id]: 'open', [stale.id]: 'archived', [done.id]: 'done' })
    expect(s.items('w1')).toHaveLength(3)
    expect(s.expire(NOW, 14)).toBe(false)
    const reloaded = store()
    reloaded.load()
    expect(reloaded.items('w1')).toHaveLength(3)
  })

  it('gives a session its open items newest first and none that expired, are done or belong to another', () => {
    const s = store()
    const older = item({ t: NOW - 3 * DAY, text: 'older' })
    const newer = item({ t: NOW - DAY, text: 'newer' })
    s.add('w1', older, true)
    s.add('w1', newer, true)
    s.add('w1', item({ t: NOW - 20 * DAY }), true)
    s.add('w1', item({ state: 'done', doneAt: NOW }), true)
    s.add('w1', item({ session: 's2' }), true)
    s.add('w2', item(), true)
    expect(s.forSession('w1', 's1', NOW, 14).map((i) => i.text)).toEqual(['newer', 'older'])
  })

  it('adopts the open items of a pane and agent into a new session id', () => {
    const s = store()
    s.add('w1', item(), true)
    s.add('w1', item({ pane: 'p2' }), true)
    s.add('w1', item({ agent: 'codex' }), true)
    expect(s.adopt('w1', 'p1', 'claude', 's9')).toBe(1)
    expect(s.forSession('w1', 's9', NOW, 14)).toHaveLength(1)
    expect(s.forSession('w1', 's1', NOW, 14)).toHaveLength(2)
    expect(s.adopt('w1', 'p1', 'claude', 's9')).toBe(0)
  })

  it('sets an unreadable file aside instead of overwriting it', () => {
    const folder = join(dir, REMEMBER_DIR)
    const first = store()
    first.add('w1', item(), true)
    writeFileSync(join(folder, 'w1.json'), '{not json')
    const second = store()
    second.load()
    expect(second.items('w1')).toEqual([])
    const names = readdirSync(folder)
    expect(names.some((name) => name.startsWith('w1.json.unreadable-'))).toBe(true)
    second.add('w1', item(), true)
    expect(readFileSync(join(folder, 'w1.json'), 'utf8')).toContain('"items"')
  })

  it('cleans the text of an item it reads from disk', () => {
    const parsed = parseRememberItem({ ...item(), text: 'a\u202Eb\u200Bc\u0085d' })
    expect(parsed?.text).toBe('a b c d')
    expect(parseRememberItem({ ...item(), text: '\u200B\u202E ' })).toBeNull()
  })

  it('refuses malformed items when it parses', () => {
    expect(parseRememberItem(item())).not.toBeNull()
    expect(parseRememberItem({ ...item(), text: '' })).toBeNull()
    expect(parseRememberItem({ ...item(), text: 'x'.repeat(201) })).toBeNull()
    expect(parseRememberItem({ ...item(), state: 'gone' })).toBeNull()
    expect(parseRememberItem({ ...item(), session: 'has space' })).toBeNull()
    expect(parseRememberItem({ ...item(), id: 'short' })).toBeNull()
  })
})
