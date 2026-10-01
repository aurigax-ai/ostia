import { describe, expect, it } from 'vitest'
import {
  DETACH_GRACE_MS,
  RECOVERY_GRACE_MS,
  RecoveryBook,
  orphanVerdict,
  planRecovery,
} from './ptyReaper'

function clock(start = 1_000) {
  let now = start
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const ORPHAN = { current: true, owners: 0, moving: false, held: false, recovering: false }

describe('orphanVerdict', () => {
  it('reaps a pty with no owners once the grace is over', () => {
    expect(orphanVerdict(ORPHAN)).toBe('reap')
  })

  it('waits instead of reaping while its window is reloading or recovering', () => {
    expect(orphanVerdict({ ...ORPHAN, recovering: true })).toBe('wait')
  })

  it('keeps a pty that is owned, moving, held for a recovered window, or replaced', () => {
    expect(orphanVerdict({ ...ORPHAN, owners: 1 })).toBe('keep')
    expect(orphanVerdict({ ...ORPHAN, moving: true })).toBe('keep')
    expect(orphanVerdict({ ...ORPHAN, held: true })).toBe('keep')
    expect(orphanVerdict({ ...ORPHAN, current: false, recovering: true })).toBe('keep')
  })
})

describe('RecoveryBook', () => {
  it('uses the normal detach grace for a window that is not recovering', () => {
    const book = new RecoveryBook(clock().now)
    expect(book.isRecovering('1')).toBe(false)
    expect(book.graceFor('1')).toBe(DETACH_GRACE_MS)
    expect(book.graceFor(undefined)).toBe(DETACH_GRACE_MS)
  })

  it('extends the grace for a recovering window only', () => {
    const c = clock()
    const book = new RecoveryBook(c.now)
    book.start('1')
    expect(book.isRecovering('1')).toBe(true)
    expect(book.isRecovering('2')).toBe(false)
    expect(book.graceFor('1')).toBe(RECOVERY_GRACE_MS)
    c.advance(60_000)
    expect(book.graceFor('1')).toBe(RECOVERY_GRACE_MS - 60_000)
    expect(book.graceFor('2')).toBe(DETACH_GRACE_MS)
  })

  it('stops recovering when the window reports ready or the recovery grace runs out', () => {
    const c = clock()
    const book = new RecoveryBook(c.now)
    book.start('1')
    expect(book.end('1')).toBe(true)
    expect(book.isRecovering('1')).toBe(false)
    expect(book.end('1')).toBe(false)
    book.start('2')
    c.advance(RECOVERY_GRACE_MS)
    expect(book.isRecovering('2')).toBe(false)
  })
})

describe('planRecovery', () => {
  it('holds detached ptys the reloaded window still shows and reaps the rest', () => {
    const plan = planRecovery(
      [
        { paneId: 'p1', owners: 0 },
        { paneId: 'p2', owners: 1 },
        { paneId: 'closed', owners: 0 },
        { paneId: 'stale', owners: 1 },
      ],
      new Set(['p1', 'p2']),
    )
    expect(plan).toEqual({ hold: ['p1'], reap: ['closed', 'stale'] })
  })
})
