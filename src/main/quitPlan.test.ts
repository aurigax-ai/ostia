import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type QuitState, exitAfterDeadline, planQuit } from './quitPlan'

const IDLE: QuitState = {
  approved: false,
  requestedByPine: false,
  signaled: false,
  platform: 'linux',
}

describe('planQuit', () => {
  it('proceeds once the quit was approved', () => {
    expect(planQuit({ ...IDLE, approved: true, signaled: true })).toBe('proceed')
  })

  it('asks about running commands when Pine itself started the quit', () => {
    expect(planQuit({ ...IDLE, requestedByPine: true })).toBe('ask')
  })

  it('quits unattended when a signal (SIGTERM, SIGINT, SIGHUP) started the quit', () => {
    expect(planQuit({ ...IDLE, signaled: true })).toBe('unattended')
  })

  it('quits unattended on Linux when neither Pine nor a known signal started the quit', () => {
    expect(planQuit(IDLE)).toBe('unattended')
  })

  it('quits unattended on macOS too when a signal started the quit', () => {
    for (const requestedByPine of [false, true]) {
      expect(planQuit({ ...IDLE, platform: 'darwin', requestedByPine, signaled: true })).toBe(
        'unattended',
      )
    }
  })

  it('still asks on macOS, where the app menu quits without going through Pine', () => {
    expect(planQuit({ ...IDLE, platform: 'darwin' })).toBe('ask')
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
