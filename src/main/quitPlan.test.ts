import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type QuitState, exitAfterDeadline, keptOnQuit, planQuit } from './quitPlan'

const IDLE: QuitState = {
  approved: false,
  requestedByOstia: false,
  signaled: false,
  platform: 'linux',
}

describe('planQuit', () => {
  it('proceeds once the quit was approved', () => {
    expect(planQuit({ ...IDLE, approved: true, signaled: true })).toBe('proceed')
  })

  it('asks about running commands when Ostia itself started the quit', () => {
    expect(planQuit({ ...IDLE, requestedByOstia: true })).toBe('ask')
  })

  it('quits unattended when a signal (SIGTERM, SIGINT, SIGHUP) started the quit', () => {
    expect(planQuit({ ...IDLE, signaled: true })).toBe('unattended')
  })

  it('quits unattended on Linux when neither Ostia nor a known signal started the quit', () => {
    expect(planQuit(IDLE)).toBe('unattended')
  })

  it('quits unattended on macOS too when a signal started the quit', () => {
    for (const requestedByOstia of [false, true]) {
      expect(planQuit({ ...IDLE, platform: 'darwin', requestedByOstia, signaled: true })).toBe(
        'unattended',
      )
    }
  })

  it('still asks on macOS, where the app menu quits without going through Ostia', () => {
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

describe('keptOnQuit', () => {
  const panes = [
    { paneId: 'p1', kept: true },
    { paneId: 'p2', kept: false },
  ]

  it('KSH-C39 names the kept shells when Ostia restarts', () => {
    expect(keptOnQuit(true, panes)).toEqual(['p1'])
  })

  it('KSH-C40 names none when Ostia quits, so every running command is asked about', () => {
    expect(keptOnQuit(false, panes)).toEqual([])
  })
})
