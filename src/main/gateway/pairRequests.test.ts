import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => process.env.XDG_DATA_HOME, getVersion: () => '0.0.0-test' },
}))

const {
  PAIR_REQUEST_TTL_MS,
  listPairRequests,
  openPairRequest,
  resetPairRequests,
  revealPairRequest,
} = await import('./pairRequests')

let prevXdg: string | undefined
beforeAll(() => {
  prevXdg = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), 'ostia-pair-requests-'))
})

afterAll(() => {
  const xdg = process.env.XDG_DATA_HOME
  if (prevXdg === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
  else process.env.XDG_DATA_HOME = prevXdg
  if (xdg) rmSync(xdg, { recursive: true, force: true })
})

afterEach(() => {
  resetPairRequests()
  vi.useRealTimers()
})

describe('gateway/pairRequests', () => {
  it('CPD-C21 tells the phone pairing expired when nobody decides in time', () => {
    vi.useFakeTimers()
    const nonce = randomBytes(32)
    const { requestId } = openPairRequest({
      name: 'Pixel 9',
      pubkey: 'pk',
      commit: createHash('sha256').update(nonce).digest('hex'),
      peer: '100.64.0.2',
    })
    const reply = vi.fn()
    expect(revealPairRequest(requestId, nonce.toString('base64'), 'sha256/fp', reply)).toBe('ok')
    expect(listPairRequests()).toHaveLength(1)

    vi.advanceTimersByTime(PAIR_REQUEST_TTL_MS)
    expect(reply).toHaveBeenCalledWith(408, { error: 'expired' })
    expect(listPairRequests()).toEqual([])
  })
})
