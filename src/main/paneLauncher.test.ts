import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OSTIA_LAUNCHER_NAME,
  ostiaLauncherScript,
  withLauncherOnPath,
  writeOstiaLauncher,
} from './paneLauncher'

const dirs: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-launcher-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ostiaLauncherScript', () => {
  it('runs the CLI through the pane node with ELECTRON_RUN_AS_NODE and forwards every argument', () => {
    expect(ostiaLauncherScript()).toBe(
      '#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${OSTIA_NODE}" "${OSTIA_CLI}" "$@"\n',
    )
  })
})

describe('writeOstiaLauncher', () => {
  it('writes an executable file only the owner can touch, and rewrites it in place', () => {
    const dir = join(scratch(), 'bin')
    writeOstiaLauncher(dir)
    writeOstiaLauncher(dir)
    const mode = statSync(join(dir, OSTIA_LAUNCHER_NAME)).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it('is found by a non-interactive shell and passes arguments and the pane env through', () => {
    const root = scratch()
    const dir = join(root, 'bin')
    writeOstiaLauncher(dir)
    const fakeNode = join(root, 'node')
    writeFileSync(fakeNode, '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$@"\n', { mode: 0o700 })
    const env = withLauncherOnPath(
      { PATH: '/usr/bin:/bin', OSTIA_NODE: fakeNode, OSTIA_CLI: 'cli.js' },
      dir,
      ':',
    )
    const found = execFileSync('/bin/sh', ['-c', 'command -v ostia'], { env }).toString().trim()
    expect(found).toBe(join(dir, 'ostia'))
    const out = execFileSync('/bin/sh', ['-c', 'ostia pane.list --help'], { env }).toString()
    expect(out.trim()).toBe('1|cli.js pane.list --help')
  })
})

describe('withLauncherOnPath', () => {
  it('puts the launcher directory first and keeps the rest in order', () => {
    expect(withLauncherOnPath({ PATH: '/usr/bin:/bin' }, '/ud/bin', ':').PATH).toBe(
      '/ud/bin:/usr/bin:/bin',
    )
  })

  it('does not repeat the directory when it is already on the path', () => {
    expect(withLauncherOnPath({ PATH: '/usr/bin:/ud/bin' }, '/ud/bin', ':').PATH).toBe(
      '/ud/bin:/usr/bin',
    )
  })

  it('sets the path when the environment has none and leaves other keys alone', () => {
    expect(withLauncherOnPath({ HOME: '/h' }, '/ud/bin', ':')).toEqual({
      HOME: '/h',
      PATH: '/ud/bin',
    })
  })
})
