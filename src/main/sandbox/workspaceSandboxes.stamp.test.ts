import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_SANDBOX_GLOBALS, emptyWorkspaceSandbox } from '../../shared/sandbox/sandbox'
import { SandboxStore } from './store'
import { WorkspaceSandboxes } from './workspaceSandboxes'

let root: string

function instance(pid: number, store: SandboxStore): WorkspaceSandboxes {
  return new WorkspaceSandboxes({
    store,
    globals: () => DEFAULT_SANDBOX_GLOBALS,
    basePaths: () => ({
      home: '/home/u',
      dataDirs: ['/home/u/.config/ostia'],
      socketPath: `/run/user/1000/ostia-${pid}.sock`,
      keptSocketPath: '/tmp/ostia-kept-1000/k.sock',
      runtimeDir: '/run/user/1000',
      agentSockets: [`/tmp/ssh-${pid}/agent.${pid}`],
      runtimeReads: [`/opt/ostia-${pid}/resources/app.asar`, '/tmp/ostia-shell-state-1000'],
    }),
    workDir: () => '/home/u/proj',
    tmpRoot: join(root, 'tmp'),
    pid,
    nodePath: process.execPath,
    hostScript: join(root, 'missing.mjs'),
    onAsk: async () => false,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ostia-sbx-stamp-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceSandboxes stamp', () => {
  it('KSH-C78 gives a kept pane the same stamp after a restart, and another one after a policy change made while Ostia was closed', () => {
    const store = new SandboxStore(join(root, 'sandbox.json'))
    store.set('ws', { ...emptyWorkspaceSandbox(), enabled: true })
    const before = instance(101, store).wrapStamp('ws')
    const after = instance(202, store).wrapStamp('ws')
    expect(before).not.toBeNull()
    expect(after).toBe(before)
    store.set('ws', { ...store.get('ws'), allowRead: ['/home/u/notes'] })
    expect(instance(303, store).wrapStamp('ws')).not.toBe(before)
  })
})
