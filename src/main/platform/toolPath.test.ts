import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fallbackDirs,
  LOGIN_PATH_TIMEOUT_MS,
  loginPathSettled,
  mergePaths,
  parseLoginPath,
  resetLoginPath,
  resolveLoginPath,
  runLoginShell,
  toolPath,
} from './toolPath'

const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
const MARK = '__OSTIA_LOGIN_PATH__'

afterEach(() => resetLoginPath())

describe('toolPath', () => {
  it('adds the Homebrew prefixes to a launchd PATH on macOS, after the PATH it was given', () => {
    expect(toolPath({ path: LAUNCHD_PATH, platform: 'darwin', home: '/Users/me' })).toBe(
      `${LAUNCHD_PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin`,
    )
  })

  it('adds the usual user and package prefixes on Linux and nothing on Windows', () => {
    expect(fallbackDirs('linux', '/home/me')).toEqual([
      '/usr/local/bin',
      '/usr/local/sbin',
      '/home/me/.local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
      '/snap/bin',
    ])
    expect(fallbackDirs('win32', 'C:\\Users\\me')).toEqual([])
  })

  it('puts the login shell PATH between the given PATH and the fallbacks, without duplicates', async () => {
    const run = async () => `${MARK}/opt/homebrew/bin:/Users/me/bin:/usr/bin\n${MARK}`
    expect(await resolveLoginPath({ platform: 'darwin', shell: '/bin/zsh', run })).toEqual({
      path: '/opt/homebrew/bin:/Users/me/bin:/usr/bin',
      ms: expect.any(Number),
    })
    expect(toolPath({ path: LAUNCHD_PATH, platform: 'darwin', home: '/Users/me' })).toBe(
      `${LAUNCHD_PATH}:/opt/homebrew/bin:/Users/me/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin`,
    )
  })

  it('runs the login shell as an interactive login shell with a time limit', async () => {
    const calls: [string, string[], number][] = []
    await resolveLoginPath({
      platform: 'linux',
      shell: '/usr/bin/fish',
      run: async (shell, args, timeoutMs) => {
        calls.push([shell, args, timeoutMs])
        return ''
      },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0][0]).toBe('/usr/bin/fish')
    expect(calls[0][1][0]).toBe('-ilc')
    expect(calls[0][1][1]).toContain('printenv PATH')
    expect(calls[0][2]).toBe(LOGIN_PATH_TIMEOUT_MS)
  })

  it('keeps the fallbacks when the login shell fails, times out or prints no PATH', async () => {
    for (const run of [
      async () => {
        throw new Error('spawn ENOENT')
      },
      async () => '',
      async () => `${MARK}${MARK}`,
      async () => `${MARK}/a\n/b${MARK}`,
    ]) {
      resetLoginPath()
      expect((await resolveLoginPath({ platform: 'darwin', shell: '/bin/zsh', run })).path).toBe(
        null,
      )
      expect(toolPath({ path: LAUNCHD_PATH, platform: 'darwin', home: '/Users/me' })).toBe(
        `${LAUNCHD_PATH}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin`,
      )
    }
  })

  it('does not start a shell on Windows', async () => {
    let ran = false
    const run = async () => {
      ran = true
      return ''
    }
    expect(await resolveLoginPath({ platform: 'win32', run })).toEqual({ path: null, ms: 0 })
    expect(ran).toBe(false)
  })

  it('lets callers wait for the login shell, and returns at once when none was started', async () => {
    await loginPathSettled()
    let finish: (output: string) => void = () => {}
    void resolveLoginPath({
      platform: 'darwin',
      shell: '/bin/zsh',
      run: () =>
        new Promise((done) => {
          finish = done
        }),
    })
    let settled = false
    const waiting = loginPathSettled().then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish(`${MARK}/late/bin${MARK}`)
    await waiting
    expect(toolPath({ path: '', platform: 'win32' })).toBe('/late/bin')
  })

  it('reads the PATH between the markers and ignores what the shell prints around them', () => {
    expect(parseLoginPath(`Last login\n${MARK}/a:/b\n${MARK}bye`)).toBe('/a:/b')
    expect(parseLoginPath('/a:/b')).toBeNull()
    expect(mergePaths('/a::/b', '/b:/c', '')).toBe('/a:/b:/c')
  })
})

describe.skipIf(process.platform === 'win32')('runLoginShell', () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('runs the login shell in a session of its own, so it can never take the launching terminal', async () => {
    const key = process.platform === 'darwin' ? 'pgid' : 'sid'
    const out = await runLoginShell('/bin/sh', ['-c', `echo $$ $(ps -o ${key}= -p $$)`], 5000)
    const [pid, leader] = out.trim().split(/\s+/)
    expect(Number(pid)).toBeGreaterThan(0)
    expect(leader).toBe(pid)
    expect(Number(leader)).not.toBe(
      Number(
        execFileSync('ps', ['-o', `${key}=`, '-p', String(process.pid)], {
          encoding: 'utf8',
        }).trim(),
      ),
    )
  })

  it('kills the whole probe, children included, when the time limit passes', async () => {
    const started = Date.now()
    const out = await runLoginShell('/bin/sh', ['-c', 'sleep 30 & echo $!; wait'], 300)
    expect(Date.now() - started).toBeLessThan(10_000)
    const child = Number(out.trim())
    expect(child).toBeGreaterThan(0)
    await expect.poll(() => alive(child)).toBe(false)
  })
})
