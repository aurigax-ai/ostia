import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KeptPlumbing, keptLauncherPaths } from './keptLaunchers'

let root: string
let launcherDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kept-launchers-'))
  launcherDir = join(root, 'userData', 'bin')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function plumbing(execPath = process.execPath, appPath = join(root, 'app')) {
  const listen = vi.fn()
  const warn = vi.fn()
  return { listen, warn, kept: new KeptPlumbing({ launcherDir, execPath, appPath, listen, warn }) }
}

function fakeCli(appPath: string, line: string): void {
  mkdirSync(join(appPath, 'out', 'cli'), { recursive: true })
  writeFileSync(join(appPath, 'out', 'cli', 'index.js'), `console.log(${JSON.stringify(line)})\n`)
}

describe('kept launchers', () => {
  it('KSH-C1 KSH-C81 with the setting off nothing for kept shells is written or listened on', () => {
    const { kept, listen } = plumbing()
    kept.start(false)
    const { node, cli } = keptLauncherPaths(launcherDir)
    expect(existsSync(node)).toBe(false)
    expect(existsSync(cli)).toBe(false)
    expect(listen).not.toHaveBeenCalled()
  })

  it('with the setting on writes both launchers once and listens once', () => {
    const { kept, listen } = plumbing()
    kept.start(true)
    kept.ensure()
    const { node, cli } = keptLauncherPaths(launcherDir)
    expect(existsSync(node)).toBe(true)
    expect(existsSync(cli)).toBe(true)
    expect(listen).toHaveBeenCalledTimes(1)
  })

  it('KSH-C33 a kept pane runs the CLI of the Ostia that is running now', () => {
    const oldApp = join(root, 'old-app')
    const newApp = join(root, 'new-app')
    fakeCli(oldApp, 'old-cli')
    fakeCli(newApp, 'new-cli')
    plumbing('/opt/old-ostia/ostia', oldApp).kept.ensure()
    plumbing(process.execPath, newApp).kept.ensure()
    const { node, cli } = keptLauncherPaths(launcherDir)
    expect(cli).toBe(join(root, 'userData', 'bin', 'ostia-cli.js'))
    const out = execFileSync(node, ['-e', 'console.log(process.execPath)', cli], {
      encoding: 'utf8',
      env: { HOME: root },
    })
    expect(out.trim()).toBe(process.execPath)
    const ran = execFileSync(node, [cli], {
      encoding: 'utf8',
      env: { HOME: root },
    })
    expect(ran.trim()).toBe('new-cli')
    expect(readFileSync(node, 'utf8')).not.toContain('old-ostia')
  })

  it('reports a launcher it cannot write and still listens', () => {
    writeFileSync(join(root, 'userData'), '')
    const { kept, listen, warn } = plumbing()
    kept.ensure()
    expect(warn).toHaveBeenCalledWith('ENOTDIR')
    expect(listen).toHaveBeenCalledTimes(1)
  })
})
