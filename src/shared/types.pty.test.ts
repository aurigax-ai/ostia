import { describe, expect, it } from 'vitest'
import type { PtyAttachResult, PtySpawnOptions } from './types'

describe('pty IPC contract', () => {
  it('attach result carries a cursor and dropped flag; opts allow a role', () => {
    const r: PtyAttachResult = { created: true, buffer: '', cursor: 0, dropped: false }
    const o: PtySpawnOptions = { cols: 80, rows: 24, role: 'observer', sinceCursor: 5 }
    expect(r.cursor).toBe(0)
    expect(o.role).toBe('observer')
  })
})
