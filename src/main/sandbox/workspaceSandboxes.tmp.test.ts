import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS, emptyWorkspaceSandbox } from '../../shared/sandbox'
import { SandboxStore } from './store'
import { WorkspaceSandboxes } from './workspaceSandboxes'

let root: string

function instance(pid: number, alive: number[] = []): WorkspaceSandboxes {
  const store = new SandboxStore(join(root, `sandbox-${pid}.json`))
  store.set('ws', { ...emptyWorkspaceSandbox(), enabled: true })
  return new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({ home: '/home/u', dataDirs: [], socketPath: '/tmp/s', runtimeReads: [] }),
    workDir: () => '/home/u/proj',
    tmpRoot: join(root, 'tmp'),
    pid,
    processAlive: (other) => alive.includes(other),
    nodePath: process.execPath,
    hostScript: join(root, 'missing.mjs'),
    onAsk: async () => false,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pine-sbx-tmp-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceSandboxes temp folders', () => {
  it('gives two running instances separate temp folders for the same workspace id', () => {
    const first = instance(101)
    const second = instance(202)
    first.config('ws')
    second.config('ws')
    expect(first.tmpDir('ws')).not.toBe(second.tmpDir('ws'))
    expect(existsSync(first.tmpDir('ws'))).toBe(true)
    expect(existsSync(second.tmpDir('ws'))).toBe(true)
  })

  it('keeps another running instance’s temp folder when one instance clears its own at quit', () => {
    const quitting = instance(101)
    const running = instance(202)
    quitting.config('ws')
    running.config('ws')
    writeFileSync(join(running.tmpDir('ws'), 'probe'), 'in use')
    quitting.clearTmp()
    expect(existsSync(quitting.tmpDir('ws'))).toBe(false)
    expect(existsSync(join(running.tmpDir('ws'), 'probe'))).toBe(true)
  })

  it('keeps the shared temp root hidden from every sandbox, whichever instance owns a folder', () => {
    const sandboxes = instance(101)
    const { filesystem } = sandboxes.config('ws')
    expect(filesystem.denyRead).toContain(join(root, 'tmp'))
    expect(filesystem.allowWrite).toContain(sandboxes.tmpDir('ws'))
  })

  it('sweeps temp folders left by instances that no longer run, and keeps live ones and its own', () => {
    const crashed = instance(101)
    const live = instance(202)
    crashed.config('ws')
    live.config('ws')
    const starting = instance(303, [202])
    starting.config('ws')
    mkdirSync(join(root, 'tmp', 'not-an-instance'))
    expect(starting.sweepTmp()).toEqual([join(root, 'tmp', '101')])
    expect(existsSync(crashed.tmpDir('ws'))).toBe(false)
    expect(existsSync(live.tmpDir('ws'))).toBe(true)
    expect(existsSync(starting.tmpDir('ws'))).toBe(true)
    expect(existsSync(join(root, 'tmp', 'not-an-instance'))).toBe(true)
  })

  it('sweeps nothing when the temp root does not exist yet', () => {
    expect(instance(101).sweepTmp()).toEqual([])
  })
})
