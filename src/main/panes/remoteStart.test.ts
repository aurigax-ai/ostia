import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { REMOTE_REGISTRY_FILE } from '../../shared/remote/remoteNode'
import type { ExtensionHost } from '../extensions/extensionHost'
import { sshRemoteStarter } from './remoteStart'

const input = {
  agent: 'claude' as const,
  prompt: 'p',
  title: 'claude',
  workspaceId: 'w1',
  root: '/r',
  repo: { id: 'r-0123456789ab', name: 'r', head: 'a'.repeat(40) },
}

const data = mkdtempSync(join(tmpdir(), 'ostia-remote-start-'))
mkdirSync(join(data, 'ssh'))
writeFileSync(join(data, 'ssh', REMOTE_REGISTRY_FILE), JSON.stringify({ w1: { host: 'box' } }))

afterAll(() => rmSync(data, { recursive: true, force: true }))

function host(running: boolean, invoke = vi.fn()) {
  return {
    processes: { isRunning: () => running },
    invoke,
    userCaller: (workspaceId: string) => ({ kind: 'user', workspaceId }),
  } as unknown as ExtensionHost
}

describe('sshRemoteStarter', () => {
  it('RMT-U2 knows a remote workspace from the saved registry, with no extension running', async () => {
    const starter = sshRemoteStarter(data, () => null)
    expect(await starter.isRemote('w1')).toBe(true)
    expect(await starter.isRemote('w2')).toBe(false)
    expect(await sshRemoteStarter(join(data, 'none'), () => null).isRemote('w1')).toBe(false)
  })

  it('RMT-U6 refuses, and never blocks, when the registry path is a symlink to a fifo', async () => {
    const other = mkdtempSync(join(tmpdir(), 'ostia-remote-link-'))
    mkdirSync(join(other, 'ssh'))
    const real = join(other, 'real.json')
    execFileSync('mkfifo', [real])
    symlinkSync(real, join(other, 'ssh', REMOTE_REGISTRY_FILE))
    await expect(sshRemoteStarter(other, () => null).isRemote('w1')).rejects.toThrow(
      /extension-unavailable/,
    )
    rmSync(other, { recursive: true, force: true })
  })

  it('RMT-U3 calls remote-start as the app and passes its answer or its refusal through', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { jobId: 'aaaa0001', ref: 'r', paneId: 'p' } })
      .mockResolvedValueOnce({ ok: false, error: 'refused', message: 'no' })
    const starter = sshRemoteStarter(data, () => host(true, invoke))
    expect(await starter.start(input)).toEqual({
      ok: true,
      jobId: 'aaaa0001',
      ref: 'r',
      paneId: 'p',
    })
    expect(invoke).toHaveBeenCalledWith(
      'ssh',
      'remote-start',
      { argv: [JSON.stringify(input)] },
      { kind: 'user', workspaceId: 'w1' },
    )
    expect(await starter.start(input)).toEqual({ ok: false, error: 'refused', message: 'no' })
  })

  it('RMT-U4 refuses with extension-unavailable when ssh is off or not running, calling nothing', async () => {
    const invoke = vi.fn()
    for (const extensions of [null, host(false, invoke)]) {
      expect(await sshRemoteStarter(data, () => extensions).start(input)).toMatchObject({
        ok: false,
        error: 'extension-unavailable',
      })
    }
    expect(invoke).not.toHaveBeenCalled()
  })
})
