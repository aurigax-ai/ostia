import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { watchPower } from './keptPower'

describe('watchPower', () => {
  it('detaches the kept shells on suspend and reconnects them on resume', () => {
    const power = new EventEmitter()
    const kept = { suspend: vi.fn(), resume: vi.fn() }
    watchPower(power, kept)
    power.emit('suspend')
    expect(kept.suspend).toHaveBeenCalledTimes(1)
    expect(kept.resume).not.toHaveBeenCalled()
    power.emit('resume')
    expect(kept.resume).toHaveBeenCalledTimes(1)
  })
})
