import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, crashReporter: {} }))

const { crashDumpDir } = await import('./testCrashDumps')

describe('crashDumpDir', () => {
  it('names the folder a test run asked for', () => {
    expect(crashDumpDir(false, { OSTIA_E2E_CRASH_DUMPS: '/tmp/out/crash-dumps' })).toBe(
      '/tmp/out/crash-dumps',
    )
  })

  it('keeps no crash dumps in a packaged app, whatever the environment says', () => {
    expect(crashDumpDir(true, { OSTIA_E2E_CRASH_DUMPS: '/tmp/out/crash-dumps' })).toBeNull()
  })

  it('keeps none without the variable or for a relative folder', () => {
    expect(crashDumpDir(false, {})).toBeNull()
    expect(crashDumpDir(false, { OSTIA_E2E_CRASH_DUMPS: 'crash-dumps' })).toBeNull()
  })
})
