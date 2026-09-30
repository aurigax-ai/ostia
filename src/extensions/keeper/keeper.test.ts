import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FAST_POLL_MS,
  IDLE_POLL_MS,
  MAX_BACKOFF_MS,
  formatQueue,
  isAllowedKeeperCall,
  newTickets,
  nextPollDelay,
  parseApprovals,
  parseDaemonStatus,
  parseUiUrl,
} from './keeper'

const fixture = (name: string): string =>
  readFileSync(join(__dirname, '../../../test/fixtures/tools/keeper', name), 'utf8')

describe('keeper CLI output parsing', () => {
  it('reads an empty approval queue', () => {
    expect(parseApprovals(fixture('approve-empty.json'))).toEqual([])
    expect(parseApprovals('null')).toEqual([])
  })

  it('reads pending approvals oldest first, without keeping the SQL', () => {
    const list = parseApprovals(fixture('approve-pending.json'))
    expect(list).toEqual([
      {
        ticket: 't-a90e',
        agent: 'codex',
        workspace: '/home/user/shop',
        intent: 'close stale carts',
        connection: 'shop-staging',
        tier: 3,
        createdAt: '2026-09-28T10:00:30Z',
        write: 'UPDATE',
      },
      {
        ticket: 't-b21c',
        agent: 'claude-code',
        workspace: '/home/user/shop',
        intent: 'count repeat customers by month',
        connection: 'shop-staging',
        tier: 2,
        createdAt: '2026-09-28T10:02:00Z',
      },
    ])
    expect(JSON.stringify(list)).not.toContain('SELECT')
  })

  it('rejects output that is not an approval list', () => {
    expect(parseApprovals('keeper: daemon not reachable')).toBeNull()
    expect(parseApprovals('{"ticket_id":"x"}')).toBeNull()
  })

  it('reads daemon status text in both states', () => {
    expect(parseDaemonStatus(fixture('status-running.txt'))).toEqual({
      running: true,
      version: '0.0.7',
    })
    expect(parseDaemonStatus(fixture('status-stopped.txt'))).toEqual({ running: false })
    expect(parseDaemonStatus('something else')).toBeNull()
  })

  it('reads the dashboard address and refuses non-loopback ones', () => {
    expect(parseUiUrl(fixture('ui.txt'))).toBe('http://127.0.0.1:7773')
    expect(parseUiUrl('http://192.168.1.4:7773')).toBeNull()
    expect(parseUiUrl('keeper: ui: the daemon is not serving a UI')).toBeNull()
  })
})

describe('keeper polling policy', () => {
  const base = { installed: true, pending: 0, focused: false, failures: 0 }

  it('stops polling when keeper is not installed', () => {
    expect(nextPollDelay({ ...base, installed: false, focused: true })).toBeNull()
  })

  it('polls fast while approvals wait or the app is focused', () => {
    expect(nextPollDelay({ ...base, pending: 2 })).toBe(FAST_POLL_MS)
    expect(nextPollDelay({ ...base, focused: true })).toBe(FAST_POLL_MS)
  })

  it('polls slowly in the background with nothing waiting', () => {
    expect(nextPollDelay(base)).toBe(IDLE_POLL_MS)
  })

  it('uses the intervals the human set', () => {
    const intervals = { fastMs: 2000, idleMs: 30_000 }
    expect(nextPollDelay({ ...base, focused: true }, intervals)).toBe(2000)
    expect(nextPollDelay(base, intervals)).toBe(30_000)
  })

  it('backs off exponentially on failures, capped', () => {
    const delays = [1, 2, 3, 10, 20].map((failures) =>
      nextPollDelay({ ...base, focused: true, failures }),
    )
    expect(delays).toEqual([10_000, 20_000, 40_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS])
  })
})

describe('keeper safety and formatting', () => {
  it('allows only the read-only invocations', () => {
    expect(isAllowedKeeperCall(['approve', '--json'])).toBe(true)
    expect(isAllowedKeeperCall(['daemon', 'status'])).toBe(true)
    expect(isAllowedKeeperCall(['ui'])).toBe(true)
    expect(isAllowedKeeperCall(['approve', 't-a90e'])).toBe(false)
    expect(isAllowedKeeperCall(['approve', '--json', 't-a90e'])).toBe(false)
    expect(isAllowedKeeperCall(['approve'])).toBe(false)
    expect(isAllowedKeeperCall(['daemon', 'start'])).toBe(false)
  })

  it('lists only tickets it has not seen before', () => {
    const list = parseApprovals(fixture('approve-pending.json')) ?? []
    expect(newTickets(new Set(['t-a90e']), list)).toEqual(['t-b21c'])
    expect(newTickets(new Set(), [])).toEqual([])
  })

  it('formats the queue like keeper approve, without SQL', () => {
    const list = parseApprovals(fixture('approve-pending.json')) ?? []
    const text = formatQueue(list, Date.parse('2026-09-28T10:05:00Z'), 'none')
    expect(text.split('\n')).toEqual([
      'TICKET  AGENT  WORKSPACE  INTENT  CONNECTION  TIER  AGE',
      't-a90e  codex  /home/user/shop  close stale carts  shop-staging  3 UPDATE  4m',
      't-b21c  claude-code  /home/user/shop  count repeat customers by month  shop-staging  2  3m',
    ])
    expect(formatQueue([], 0, 'none')).toBe('none')
  })
})
