import { describe, expect, it, vi } from 'vitest'
import { ghosttyFailure, ghosttyModule, loadGhostty } from './ghosttyEngine'

vi.mock('./ghosttyTerminal', () => ({
  loadGhosttyEngine: () => Promise.reject(new Error('instantiate failed')),
}))

describe('ghosttyEngine', () => {
  it('remembers why the engine could not load and stays unloaded', async () => {
    expect(ghosttyFailure()).toBeNull()
    await expect(loadGhostty()).rejects.toThrow('instantiate failed')
    expect(ghosttyFailure()).toBe('instantiate failed')
    expect(ghosttyModule()).toBeNull()
  })
})
