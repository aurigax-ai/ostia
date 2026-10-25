import { describe, expect, it, vi } from 'vitest'
import { relaunchWithoutNoNewPrivs } from './noNewPrivsRelaunch'

function run(over: { noNewPrivs?: boolean; env?: NodeJS.ProcessEnv; launched?: boolean }) {
  const env = over.env ?? { PATH: '/usr/bin' }
  const launch = vi.fn(() => over.launched ?? true)
  const warn = vi.fn()
  const result = relaunchWithoutNoNewPrivs({
    noNewPrivs: over.noNewPrivs ?? true,
    env,
    launch,
    warn,
  })
  return { result, env, launch, warn }
}

describe('relaunchWithoutNoNewPrivs', () => {
  it('relaunches once with the loop marker when the flag is set', () => {
    const { result, launch, warn } = run({})
    expect(result).toBe(true)
    expect(launch).toHaveBeenCalledWith({ PATH: '/usr/bin', OSTIA_NO_NEW_PRIVS_RELAUNCHED: '1' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does nothing when the flag is clear', () => {
    const { result, launch, warn } = run({ noNewPrivs: false })
    expect(result).toBe(false)
    expect(launch).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('never relaunches twice and says the flag survived', () => {
    const { result, launch, warn } = run({ env: { OSTIA_NO_NEW_PRIVS_RELAUNCHED: '1' } })
    expect(result).toBe(false)
    expect(launch).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('removes the marker so panes never inherit it', () => {
    const { env } = run({ noNewPrivs: false, env: { OSTIA_NO_NEW_PRIVS_RELAUNCHED: '1' } })
    expect(env.OSTIA_NO_NEW_PRIVS_RELAUNCHED).toBeUndefined()
  })

  it('starts this instance and warns when systemd cannot launch', () => {
    const { result, warn } = run({ launched: false })
    expect(result).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
