import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQuitTrace,
  exitAfterDeadline,
  keepsShellsOnQuit,
  keptOnQuit,
  planQuit,
  type QuitState,
  summarizeKinds,
} from './quitPlan'

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

  it('KSH-C39 leaves the kept shells out of the question when Ostia restarts, since they live on', () => {
    expect(keptOnQuit(true, true, panes)).toEqual({ kept: ['p1'], offer: [] })
  })

  it('KSH-C40 offers to keep the kept shells when Ostia quits and asks before quitting', () => {
    expect(keptOnQuit(false, true, panes)).toEqual({ kept: ['p1'], offer: ['p1'] })
  })

  it('KSH-C92 offers nothing when no shell is kept', () => {
    expect(keptOnQuit(false, true, [{ paneId: 'p2', kept: false }])).toEqual({
      kept: [],
      offer: [],
    })
  })

  it('KSH-C93 offers nothing and asks about every command when quitting does not ask', () => {
    expect(keptOnQuit(false, false, panes)).toEqual({ kept: [], offer: [] })
  })
})

describe('keepsShellsOnQuit', () => {
  it('KSH-C94 keeps the shells when the quit chose to keep them', () => {
    expect(keepsShellsOnQuit(false, 'keep-shells')).toBe(true)
  })

  it('KSH-C95 ends the shells when the quit chose to end them or nobody was asked', () => {
    expect(keepsShellsOnQuit(false, 'quit')).toBe(false)
    expect(keepsShellsOnQuit(false, null)).toBe(false)
  })

  it('KSH-C96 keeps the shells on a restart whatever the answer', () => {
    expect(keepsShellsOnQuit(true, null)).toBe(true)
    expect(keepsShellsOnQuit(true, 'quit')).toBe(true)
  })
})

describe('createQuitTrace', () => {
  it('logs each stage with the stage before it, how long that one took and the time since the quit began', () => {
    const entries: [string, Record<string, string | number>][] = []
    let clock = 1000
    const trace = createQuitTrace(
      (event, fields) => entries.push([event, fields]),
      () => clock,
    )
    expect(trace.current()).toBe('idle')
    expect(trace.elapsedMs()).toBe(0)
    trace.stage('scrollback')
    clock += 40
    trace.stage('telemetry')
    clock += 5
    trace.stage('teardown')
    clock += 7
    expect(entries).toEqual([
      ['quit-stage', { stage: 'scrollback', after: 'idle', tookMs: 0, totalMs: 0 }],
      ['quit-stage', { stage: 'telemetry', after: 'scrollback', tookMs: 40, totalMs: 40 }],
      ['quit-stage', { stage: 'teardown', after: 'telemetry', tookMs: 5, totalMs: 45 }],
    ])
    expect(trace.current()).toBe('teardown')
    expect(trace.elapsedMs()).toBe(52)
  })
})

describe('summarizeKinds', () => {
  it('counts the resources that keep the process alive by kind, in a stable order', () => {
    expect(summarizeKinds(['TCPSocketWrap', 'ProcessWrap', 'TCPSocketWrap', 'Timeout'])).toBe(
      'ProcessWrap:1,TCPSocketWrap:2,Timeout:1',
    )
    expect(summarizeKinds([])).toBe('')
  })
})
