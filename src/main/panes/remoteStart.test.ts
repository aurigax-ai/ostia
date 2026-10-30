import { describe, expect, it, vi } from 'vitest'
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

function host(items: object[], invoke = vi.fn()) {
  return {
    slots: { sidebarItems: () => items },
    invoke,
    userCaller: (workspaceId: string) => ({ kind: 'user', workspaceId }),
  } as unknown as ExtensionHost
}

describe('sshRemoteStarter', () => {
  it('RMT-U2 treats only a workspace the ssh extension marked as remote', () => {
    const items = [
      { extId: 'ssh', key: 'remote', workspaceId: 'w1' },
      { extId: 'other', key: 'remote', workspaceId: 'w2' },
      { extId: 'ssh', key: 'other', workspaceId: 'w3' },
    ]
    const starter = sshRemoteStarter(() => host(items))
    expect(starter.isRemote('w1')).toBe(true)
    expect(starter.isRemote('w2')).toBe(false)
    expect(starter.isRemote('w3')).toBe(false)
    expect(sshRemoteStarter(() => null).isRemote('w1')).toBe(false)
  })

  it('RMT-U3 calls remote-start as the app and passes its answer or its refusal through', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: { jobId: 'aaaa0001', ref: 'r', paneId: 'p' } })
      .mockResolvedValueOnce({ ok: false, error: 'refused', message: 'no' })
    const starter = sshRemoteStarter(() => host([], invoke))
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

  it('RMT-U4 answers extension-unavailable when no extension host is up', async () => {
    expect(await sshRemoteStarter(() => null).start(input)).toMatchObject({
      ok: false,
      error: 'extension-unavailable',
    })
  })
})
