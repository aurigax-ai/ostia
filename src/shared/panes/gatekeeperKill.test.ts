import { describe, expect, it } from 'vitest'
import {
  DEVELOPER_TOOLS_SETTING_URL,
  GATEKEEPER_WINDOW_MS,
  gatekeeperHint,
  maybeEndedByGatekeeper,
  SIGKILL_EXIT_CODE,
} from './gatekeeperKill'

const base = { platform: 'darwin', exitCode: SIGKILL_EXIT_CODE, ranMs: 1200 } as const

describe('maybeEndedByGatekeeper', () => {
  it('flags a SIGKILL exit on macOS shortly after the command started', () => {
    expect(maybeEndedByGatekeeper(base)).toBe(true)
    expect(maybeEndedByGatekeeper({ ...base, ranMs: 0 })).toBe(true)
  })

  it('stops flagging at the window boundary', () => {
    expect(maybeEndedByGatekeeper({ ...base, ranMs: GATEKEEPER_WINDOW_MS - 1 })).toBe(true)
    expect(maybeEndedByGatekeeper({ ...base, ranMs: GATEKEEPER_WINDOW_MS })).toBe(false)
    expect(maybeEndedByGatekeeper({ ...base, ranMs: GATEKEEPER_WINDOW_MS + 1 })).toBe(false)
  })

  it('ignores other platforms', () => {
    expect(maybeEndedByGatekeeper({ ...base, platform: 'linux' })).toBe(false)
    expect(maybeEndedByGatekeeper({ ...base, platform: 'win32' })).toBe(false)
  })

  it('ignores other exit codes and unknown ones', () => {
    for (const exitCode of [0, 1, 130, 136, 138, 143, undefined]) {
      expect(maybeEndedByGatekeeper({ ...base, exitCode })).toBe(false)
    }
  })

  it('ignores a run whose duration is unknown or negative', () => {
    expect(maybeEndedByGatekeeper({ ...base, ranMs: undefined })).toBe(false)
    expect(maybeEndedByGatekeeper({ ...base, ranMs: -1 })).toBe(false)
  })
})

describe('gatekeeperHint', () => {
  it('names the cause as possible, gives the steps and links the setting', () => {
    const hint = gatekeeperHint('Ostia')
    expect(hint).toContain('Gatekeeper may have ended')
    expect(hint).toContain('Privacy & Security > Developer Tools')
    expect(hint).toContain('turn on Ostia')
    expect(hint).toContain(DEVELOPER_TOOLS_SETTING_URL)
    expect(hint).toContain(`${GATEKEEPER_WINDOW_MS / 1000} seconds`)
  })

  it('does not tell the user to strip the quarantine attribute or claim a state', () => {
    const hint = gatekeeperHint('Ostia')
    expect(hint).not.toMatch(/xattr|quarantine/i)
    expect(hint).not.toMatch(/is (not )?enabled|is disabled/i)
  })
})
