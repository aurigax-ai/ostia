import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createScriptTokenUsage, USAGE_KEEP } from './scriptTokenUsage'

const HOUR = 3_600_000
let dir = ''
let file = ''
let clock = Date.parse('2026-10-11T12:00:00.000Z')
const log = () => createScriptTokenUsage(() => file, { now: () => clock, flushMs: 60_000 })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'script-token-usage-'))
  file = join(dir, 'script-token-usage.json')
  clock = Date.parse('2026-10-11T12:00:00.000Z')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('script token usage log', () => {
  it(`keeps the newest ${USAGE_KEEP} calls and drops the oldest`, () => {
    const usage = log()
    for (let i = 0; i < USAGE_KEEP + 5; i++) {
      clock += 1_000
      usage.record('t1', { method: `m${i}`, target: {}, outcome: 'ok' })
    }
    const calls = usage.usage('t1').calls
    expect(calls).toHaveLength(USAGE_KEEP)
    expect(calls[0].method).toBe(`m${USAGE_KEEP + 4}`)
    expect(calls.at(-1)?.method).toBe('m5')
    expect(usage.usage('t1').last24h).toEqual({ calls: USAGE_KEEP + 5, refused: 0 })
  })

  it('counts refused calls and forgets the ones older than 24 hours', () => {
    const usage = log()
    usage.record('t1', { method: 'pane.read', target: {}, outcome: 'ok' })
    clock += 25 * HOUR
    usage.record('t1', { method: 'pane.read', target: {}, outcome: 'out-of-scope' })
    usage.record('t1', { method: 'pane.close', target: {}, outcome: 'missing-permission' })
    usage.record('t1', { method: 'x', target: {}, outcome: 'error', code: 'bad-request' })
    expect(usage.usage('t1').last24h).toEqual({ calls: 3, refused: 2 })
    expect(usage.usage('t1').calls).toHaveLength(4)
  })

  it('writes the file later, owner only and unindented, and reads it back after a restart', async () => {
    const usage = log()
    usage.record('t1', {
      method: 'pane.read',
      target: { workspaceId: 'w1', paneId: 'p1' },
      outcome: 'ok',
    })
    expect(existsSync(file)).toBe(false)
    const pending = usage.flush()
    expect(existsSync(file)).toBe(false)
    await pending
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain('\n')
    expect(log().usage('t1')).toMatchObject({
      calls: [{ method: 'pane.read', target: { workspaceId: 'w1', paneId: 'p1' }, outcome: 'ok' }],
      last24h: { calls: 1, refused: 0 },
    })
  })

  it('stores only the fields it is given', async () => {
    const usage = log()
    usage.record('t1', { method: 'pane.input', target: { paneId: 'p1' }, outcome: 'ok' })
    await usage.flush()
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).t1.calls[0]).sort()).toEqual([
      'at',
      'method',
      'outcome',
      'target',
    ])
  })

  it('clears a token and its connections', async () => {
    const usage = log()
    usage.connected('t1', { pid: 1 })
    usage.record('t1', { method: 'notify', target: {}, outcome: 'ok' })
    usage.record('t2', { method: 'notify', target: {}, outcome: 'ok' })
    usage.clear('t1')
    await usage.flush()
    expect(usage.usage('t1')).toEqual({
      calls: [],
      connections: [],
      last24h: { calls: 0, refused: 0 },
    })
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['t2'])
  })

  it('notes a regeneration without counting it as a call, and drops the old connections', () => {
    const usage = log()
    const release = usage.connected('t1', { pid: 7 })
    usage.regenerated('t1')
    expect(usage.usage('t1')).toMatchObject({
      calls: [{ method: '', outcome: 'regenerated' }],
      connections: [],
      last24h: { calls: 0, refused: 0 },
    })
    const fresh = usage.connected('t1', {})
    release()
    expect(usage.usage('t1').connections).toEqual([{}])
    fresh()
    expect(usage.usage('t1').connections).toEqual([])
  })

  it('counts each open connection with its process', () => {
    const usage = log()
    const a = usage.connected('t1', { pid: 41 })
    usage.connected('t1', { pid: 42 })
    expect(usage.usage('t1').connections).toEqual([{ pid: 41 }, { pid: 42 }])
    a()
    a()
    expect(usage.usage('t1').connections).toEqual([{ pid: 42 }])
  })

  it('drops a call that finishes after its token was revoked', async () => {
    const usage = log()
    usage.record('t1', { method: 'pane.read', target: {}, outcome: 'ok' })
    usage.clear('t1')
    usage.record('t1', { method: 'pane.read', target: {}, outcome: 'ok' })
    usage.regenerated('t1')
    expect(usage.usage('t1').calls).toEqual([])
    await usage.flush()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
  })

  it('leaves out tokens that no longer exist when it writes', async () => {
    const usage = createScriptTokenUsage(() => file, { known: () => new Set(['t2']) })
    usage.record('t1', { method: 'notify', target: {}, outcome: 'ok' })
    usage.record('t2', { method: 'notify', target: {}, outcome: 'ok' })
    await usage.flush()
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['t2'])
  })

  it('writes at once on close', () => {
    const usage = log()
    usage.record('t1', { method: 'notify', target: {}, outcome: 'ok' })
    usage.close()
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['t1'])
  })
})
