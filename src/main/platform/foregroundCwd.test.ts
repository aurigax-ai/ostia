import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { darwinForegroundCwd, linuxForegroundCwd, type ToolRun } from './foregroundCwd'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fakeProc(shellStat: string, cwds: Record<number, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fake-proc-'))
  roots.push(root)
  mkdirSync(join(root, '100'))
  writeFileSync(join(root, '100', 'stat'), shellStat)
  for (const [pid, cwd] of Object.entries(cwds)) {
    mkdirSync(join(root, pid), { recursive: true })
    symlinkSync(cwd, join(root, pid, 'cwd'))
  }
  return root
}

const shellStat = (tpgid: number) =>
  `100 (bash) S 1 100 100 34816 ${tpgid} 4194304 0 0 0 0 0 0 0 0 20 0 1 0`

describe('linuxForegroundCwd', () => {
  it('reads the folder of the pane’s foreground process group, not the shell’s', async () => {
    const root = fakeProc(shellStat(200), { 100: '/home/u', 200: '/home/u/work/tree' })
    expect(await linuxForegroundCwd(100, root)).toBe('/home/u/work/tree')
  })

  it('answers a removed folder by its path, so resuming shows it missing instead of moving elsewhere', async () => {
    expect(
      await linuxForegroundCwd(100, fakeProc(shellStat(200), { 200: '/home/u/tree (deleted)' })),
    ).toBe('/home/u/tree')
  })

  it('answers nothing when the group is gone or the shell is unknown', async () => {
    expect(await linuxForegroundCwd(100, fakeProc(shellStat(300), {}))).toBeNull()
    expect(await linuxForegroundCwd(100, fakeProc(shellStat(-1), {}))).toBeNull()
    expect(await linuxForegroundCwd(999, fakeProc(shellStat(200), {}))).toBeNull()
  })
})

describe('darwinForegroundCwd', () => {
  function tools(answers: Record<string, string>): { run: ToolRun; calls: string[][] } {
    const calls: string[][] = []
    const run: ToolRun = async (bin, args) => {
      calls.push([bin, ...args])
      return answers[bin] ?? ''
    }
    return { run, calls }
  }

  it('asks ps for the foreground group and lsof for that process’s folder', async () => {
    const { run, calls } = tools({
      '/bin/ps': '  200\n',
      '/usr/sbin/lsof': 'p200\nfcwd\nn/Users/u/work/tree\n',
    })
    expect(await darwinForegroundCwd(100, run)).toBe('/Users/u/work/tree')
    expect(calls).toEqual([
      ['/bin/ps', '-o', 'tpgid=', '-p', '100'],
      ['/usr/sbin/lsof', '-a', '-p', '200', '-d', 'cwd', '-Fn'],
    ])
  })

  it('answers nothing without a foreground group or a folder', async () => {
    expect(await darwinForegroundCwd(100, tools({ '/bin/ps': '' }).run)).toBeNull()
    expect(await darwinForegroundCwd(100, tools({ '/bin/ps': '0' }).run)).toBeNull()
    expect(
      await darwinForegroundCwd(100, tools({ '/bin/ps': '200', '/usr/sbin/lsof': 'p200\n' }).run),
    ).toBeNull()
  })
})
