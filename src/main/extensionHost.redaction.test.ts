import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp' }, ipcMain: { handle: vi.fn() } }))

const { withoutCorrection } = await import('./extensionHost')

describe('withoutCorrection', () => {
  it('drops a typo correction made from a redacted draft, so accepting it cannot lose the secret', () => {
    const reply = {
      ok: true as const,
      result: { corrected: 'use [redacted:github] here', review: { notes: ['short'] } },
    }
    expect(withoutCorrection('input', reply)).toEqual({
      ok: true,
      result: { review: { notes: ['short'] } },
    })
  })

  it('leaves failures and the other points as they are', () => {
    const failed = { ok: false as const, error: 'failed' as const }
    expect(withoutCorrection('input', failed)).toBe(failed)
    const suggestions = { ok: true as const, result: { suggestions: [{ command: 'ls' }] } }
    expect(withoutCorrection('command', suggestions)).toBe(suggestions)
  })
})
