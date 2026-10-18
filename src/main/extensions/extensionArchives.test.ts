import type { ChildProcess } from 'node:child_process'
import type { ExtensionManifest } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it, vi } from 'vitest'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { ExtensionArchives } from './extensionArchives'
import { type Runtime, newRuntime } from './extensionRuntime'

const GRACE_MS = 50
const LIST = {
  op: 'list',
  reader: 'xz',
  archive: '/a.tar.xz',
  limits: { entries: 1, depth: 1, nameLength: 1, scanBytes: 1, scanMs: 1, linkTargetBytes: 1 },
} as const

function runtime(): Runtime {
  const manifest = {
    id: 'archives',
    contributes: { archiveReaders: [{ id: 'xz', displayName: 'xz', selector: [] }] },
  } as unknown as ExtensionManifest
  const rt = newRuntime({ dir: '/ext', builtin: true, manifest, catalogs: {} as never })
  rt.state = 'running'
  rt.proc = { pid: 1 } as ChildProcess
  return rt
}

function archivesFor(rt: Runtime, recycle: (rt: Runtime) => void): ExtensionArchives {
  const conn = { sendRequest: () => new Promise(() => {}) } as unknown as MessageConnection
  return new ExtensionArchives({
    deps: { archiveKillGraceMs: GRACE_MS },
    runtimes: new Map([['archives', rt]]),
    active: () => true,
    processes: { connected: async () => conn, recycle },
  })
}

describe('ExtensionArchives', () => {
  it('stops the process that did not answer once the grace after the cancel is over', async () => {
    const rt = runtime()
    const recycle = vi.fn()
    await expect(archivesFor(rt, recycle).request('archives', LIST, 10)).rejects.toThrow(
      /timed out/,
    )
    expect(recycle).toHaveBeenCalledWith(rt)
  })

  it('leaves a process alone that replaced the one that did not answer', async () => {
    const rt = runtime()
    const recycle = vi.fn()
    const pending = archivesFor(rt, recycle).request('archives', LIST, 10)
    setTimeout(() => {
      rt.proc = { pid: 2 } as ChildProcess
    }, 20)
    await expect(pending).rejects.toThrow(/timed out/)
    expect(recycle).not.toHaveBeenCalled()
  })
})
