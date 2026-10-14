import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rm = vi.hoisted(() => vi.fn())
vi.mock('./bundleFs', async () => {
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { bundleFs: { ...fs, promises: { ...fs.promises, rm } } }
})

const { sweepUpdateLeftovers } = await import('./launchSweep')
const realRm = (await vi.importActual<typeof import('node:fs')>('node:fs')).promises.rm

const VERSION = '9.9.9'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-launch-sweep-'))
  rm.mockReset()
  rm.mockImplementation(realRm)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function appFolder(dir: string): void {
  mkdirSync(join(dir, 'resources'), { recursive: true })
  writeFileSync(join(dir, 'resources', 'app.asar'), 'asar')
}

function sweep(appDir: string, overrides: { macInstall?: boolean; version?: string } = {}) {
  const swept = vi.fn()
  const warn = vi.fn()
  const done = sweepUpdateLeftovers({
    pending: { appDir, version: VERSION },
    appDir,
    version: overrides.version ?? `${VERSION}+sha.abc`,
    macInstall: overrides.macInstall ?? false,
    swept,
    warn,
  })
  return { done, swept, warn }
}

describe('sweepUpdateLeftovers', () => {
  it('the old app folder of a finished update is deleted at launch, app.asar included', async () => {
    const appDir = join(root, 'ostia')
    appFolder(appDir)
    appFolder(`${appDir}.old`)
    const { done, swept, warn } = sweep(appDir)
    await done
    expect(readdirSync(root)).toEqual(['ostia'])
    expect(rm).toHaveBeenCalledWith(`${appDir}.old`, { recursive: true, force: true })
    expect(swept).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('a staged copy and an old app left by an earlier update are deleted at launch, app.asar included', async () => {
    const bundle = join(root, 'Ostia.app')
    appFolder(bundle)
    appFolder(join(root, '.Ostia.app.new'))
    appFolder(`${bundle}.old`)
    const { done, swept, warn } = sweep(bundle, { macInstall: true })
    await done
    expect(readdirSync(root)).toEqual(['Ostia.app'])
    expect(rm.mock.calls.map(([path]) => path).sort()).toEqual([
      join(root, '.Ostia.app.new'),
      `${bundle}.old`,
    ])
    expect(swept).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalled()
  })

  it('keeps the old folder and its record until the updated version runs', async () => {
    const appDir = join(root, 'ostia')
    appFolder(appDir)
    appFolder(`${appDir}.old`)
    const { done, swept } = sweep(appDir, { version: '1.0.0' })
    await done
    expect(readdirSync(root).sort()).toEqual(['ostia', 'ostia.old'])
    expect(swept).not.toHaveBeenCalled()
  })

  it('logs a failed sweep and keeps the record', async () => {
    rm.mockRejectedValue(new Error('EBUSY'))
    const bundle = join(root, 'Ostia.app')
    const { done, swept, warn } = sweep(bundle, { macInstall: true })
    await done
    expect(warn.mock.calls.map(([event]) => event).sort()).toEqual([
      'install-sweep-failed',
      'update-staged-discard-failed',
    ])
    expect(swept).not.toHaveBeenCalled()
  })
})
