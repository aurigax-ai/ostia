import { describe, expect, it } from 'vitest'
import { listTarEntries, readTarIndex } from './tarScan'

const LIMITS = { entries: 10, scanBytes: 1024 * 1024, scanMs: 20_000 }

function settled<T>(work: Promise<T>): Promise<T | 'hung'> {
  return Promise.race([work, new Promise<'hung'>((done) => setTimeout(() => done('hung'), 1000))])
}

describe('tarScan', () => {
  it('ends at once when the opener rejects', async () => {
    const failing = () => Promise.reject(new Error('cannot open'))
    expect(await settled(listTarEntries(failing, LIMITS))).toEqual({ entries: [], end: 'stopped' })
    expect(await settled(readTarIndex(failing, 0, 1024, LIMITS))).toEqual({
      ok: false,
      problem: 'gone',
    })
  })
})
