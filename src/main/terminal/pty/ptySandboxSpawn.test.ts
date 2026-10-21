import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../../../shared/app/dict'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const { createSandboxSpawn } = await import('./ptySandboxSpawn')

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function spawner() {
  const tmp = mkdtempSync(join(tmpdir(), 'ostia-sandbox-spawn-'))
  dirs.push(tmp)
  const wrapped: unknown[][] = []
  const spawn = createSandboxSpawn({
    workspaceSandboxes: {
      tmp: { tmpDir: () => tmp },
      resolved: () => ({ switches: { unixSockets: false } }),
      packagePolicy: () => ({ cooldownDays: 0 }),
      hosts: { connect: async () => {}, isKept: () => true },
      workDir: () => tmp,
      wrapStamp: () => 'stamp',
      wrap: async (...args: unknown[]) => {
        wrapped.push(args)
        return 'wrapped'
      },
    } as never,
    keptShells: {} as never,
    injectSecrets: async () => ({ env: {}, notice: '' }),
    onSandboxSpawnFailure: () => null,
    bannerText: () => en.native.paneBanner,
  })
  return { spawn, wrapped, tmp }
}

function sandboxedPlan(tmp: string, stateFile: string | null) {
  return {
    identity: { token: 't' },
    workspaceId: 'w-sbx',
    shell: '/bin/bash',
    stateFile,
    markNonceFile: null,
    wantsKeep: false,
    portBridge: null,
    tokenFile: null,
    notKept: '',
    args: [],
    env: { SHELL: '/bin/bash' },
    cwd: tmp,
  } as never
}

describe('a sandboxed pane', () => {
  it('opens with no state file when the shell state folder was unavailable', async () => {
    const { spawn, wrapped, tmp } = spawner()
    const result = (await spawn.spawnSandboxed('p-sbx', sandboxedPlan(tmp, null))) as {
      file: string
    }
    expect(result.file).toBe('/bin/sh')
    expect(wrapped).toHaveLength(1)
    expect(wrapped[0][3]).toEqual([])
  })

  it('creates its state file and lists it for the sandbox when there is one', async () => {
    const { spawn, wrapped, tmp } = spawner()
    const stateFile = join(tmp, 'state')
    await spawn.spawnSandboxed('p-sbx', sandboxedPlan(tmp, stateFile))
    expect(existsSync(stateFile)).toBe(true)
    expect(wrapped[0][3]).toEqual([stateFile])
  })
})
