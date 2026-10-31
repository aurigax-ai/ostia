import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS, emptyWorkspaceSandbox } from '../../shared/sandbox/sandbox'
import { buildSrtConfig } from './srtConfig'
import { SandboxStore } from './store'
import { WorkspaceSandboxes } from './workspaceSandboxes'

let root: string

const MACOS_TMP_ROOT = '/private/var/folders/36/tjdph2t965j8snz9_vkdnw0r0000gn/T/ostia-sbx-501'

function instance(
  pid: number,
  alive: number[] = [],
  tmpRoot = join(root, 'tmp'),
): WorkspaceSandboxes {
  const store = new SandboxStore(join(root, `sandbox-${pid}.json`))
  store.set('ws', { ...emptyWorkspaceSandbox(), enabled: true })
  return new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({ home: '/home/u', dataDirs: [], socketPath: '/tmp/s', runtimeReads: [] }),
    workDir: () => '/home/u/proj',
    tmpRoot,
    pid,
    processAlive: (other) => alive.includes(other),
    nodePath: process.execPath,
    hostScript: join(root, 'missing.mjs'),
    onAsk: async () => false,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-sbx-tmp-'))
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
    expect(first.tmp.tmpDir('ws')).not.toBe(second.tmp.tmpDir('ws'))
    expect(existsSync(first.tmp.tmpDir('ws'))).toBe(true)
    expect(existsSync(second.tmp.tmpDir('ws'))).toBe(true)
  })

  it('keeps another running instance’s temp folder when one instance clears its own at quit', () => {
    const quitting = instance(101)
    const running = instance(202)
    quitting.config('ws')
    running.config('ws')
    writeFileSync(join(running.tmp.tmpDir('ws'), 'probe'), 'in use')
    quitting.tmp.clearTmp()
    expect(existsSync(quitting.tmp.tmpDir('ws'))).toBe(false)
    expect(existsSync(join(running.tmp.tmpDir('ws'), 'probe'))).toBe(true)
  })

  it('a sandboxed shell keeps its temp folder when another Ostia quits', () => {
    const running = instance(202)
    running.config('ws')
    writeFileSync(join(running.tmp.tmpDir('ws'), 'probe'), 'in use')
    const other = instance(303, [202])
    other.tmp.sweepTmp()
    other.config('ws')
    other.tmp.clearTmp()
    expect(existsSync(join(running.tmp.tmpDir('ws'), 'probe'))).toBe(true)
    expect(running.config('ws').filesystem.allowWrite).toContain(running.tmp.tmpDir('ws'))
  })

  it('keeps the shared temp root hidden from every sandbox, whichever instance owns a folder', () => {
    const sandboxes = instance(101)
    const { filesystem } = sandboxes.config('ws')
    expect(filesystem.denyRead).toContain(join(root, 'tmp'))
    expect(filesystem.allowWrite).toContain(sandboxes.tmp.tmpDir('ws'))
  })

  it('sweeps temp folders left by instances that no longer run, and keeps live ones and its own', () => {
    const crashed = instance(101)
    const live = instance(202)
    crashed.config('ws')
    live.config('ws')
    const starting = instance(303, [202])
    starting.config('ws')
    mkdirSync(join(root, 'tmp', 'not-an-instance'))
    expect(starting.tmp.sweepTmp()).toEqual([join(root, 'tmp', '101')])
    expect(existsSync(crashed.tmp.tmpDir('ws'))).toBe(false)
    expect(existsSync(live.tmp.tmpDir('ws'))).toBe(true)
    expect(existsSync(starting.tmp.tmpDir('ws'))).toBe(true)
    expect(existsSync(join(root, 'tmp', 'not-an-instance'))).toBe(true)
  })

  it('sweeps nothing when the temp root does not exist yet', () => {
    expect(instance(101).tmp.sweepTmp()).toEqual([])
  })

  it('puts the ssh-agent socket inside the temp folder, short enough for macOS and allowed there', () => {
    const sandboxes = instance(1234567, [], MACOS_TMP_ROOT)
    const workspaceId = 'ws-3f9a2c-17'
    const socket = sandboxes.tmp.sshAgentSocket(workspaceId)
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(103)
    expect(socket.startsWith(`${sandboxes.tmp.tmpDir(workspaceId)}/`)).toBe(true)
    const config = buildSrtConfig(
      { allowRead: [], domains: [] },
      {
        home: '/Users/u',
        dataDirs: [],
        socketPath: '/tmp/s',
        runtimeReads: [],
        workDir: '/Users/u/proj',
        tmpDir: sandboxes.tmp.tmpDir(workspaceId),
      },
      'darwin',
    )
    expect(config.network.allowUnixSockets).toContain(socket)
    expect(config.filesystem.allowWrite).toContain(sandboxes.tmp.tmpDir(workspaceId))
  })

  it('keeps a private plugins folder beside the temp folder and removes it with the sandbox', () => {
    const sandboxes = instance(101)
    sandboxes.config('ws')
    const plugins = sandboxes.tmp.pluginsDir('ws')
    expect(plugins).not.toBe(sandboxes.tmp.tmpDir('ws'))
    expect(readlinkSync(join(plugins, 'data'))).toBe(sandboxes.tmp.pluginsData('ws'))
    sandboxes.tmp.remove('ws')
    expect(existsSync(plugins)).toBe(false)
  })
})
