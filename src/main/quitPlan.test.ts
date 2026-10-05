import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exitAfterDeadline, planQuit } from './quitPlan'

describe('planQuit', () => {
  it('proceeds once the quit was approved', () => {
    expect(planQuit({ approved: true, requestedByOstia: false, platform: 'linux' })).toBe('proceed')
  })

  it('asks about running commands when Ostia itself started the quit', () => {
    expect(planQuit({ approved: false, requestedByOstia: true, platform: 'linux' })).toBe('ask')
  })

  it('quits unattended when a signal (SIGTERM, SIGINT, SIGHUP) started the quit', () => {
    expect(planQuit({ approved: false, requestedByOstia: false, platform: 'linux' })).toBe(
      'unattended',
    )
  })

  it('still asks on macOS, where the app menu quits without going through Ostia', () => {
    expect(planQuit({ approved: false, requestedByOstia: false, platform: 'darwin' })).toBe('ask')
  })
})

describe('exitAfterDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('exits when the quit has not finished by the deadline', () => {
    const exit = vi.fn()
    exitAfterDeadline(exit, 1000)
    vi.advanceTimersByTime(999)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
