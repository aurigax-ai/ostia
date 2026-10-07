import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionCaller } from '../shared/extensions'
import type { RemoteFolder } from '../shared/remoteFolders'
import type { CommandResult } from '../shared/types'
import { registerControlServer, stopControlServer } from './controlServer'
import { ExtensionHost, registerExtensionMethods } from './extensionHost'
import { ExtensionStore } from './extensionStore'
import { registerPane } from './idRegistry'
import type { RemoteFolderConfirm, RemoteFolders } from './remoteFolders'

const fixtures = resolve(__dirname, '../../test/fixtures/extensions-folders')
const caller: ExtensionCaller = { kind: 'user', workspaceId: 'w1', capabilities: [] }

describe('ExtensionHost remote folders (real extension process, real socket)', () => {
  let dir: string
  let host: ExtensionHost
  let folders: RemoteFolders
  const owners = new Map([['w1', 'win1']])
  const confirm = vi.fn<(req: RemoteFolderConfirm) => Promise<boolean>>()
  const published: RemoteFolder[][] = []

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-ext-folders-'))
    const socketPath = join(dir, 'control.sock')
    registerPane({ windowId: 'win1', workspaceId: 'w1', paneId: 'pane-remote' })
    host = new ExtensionHost({
      roots: [{ dir: fixtures, builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      readyTimeoutMs: 8000,
      requestTimeoutMs: 1500,
      interactiveTimeoutMs: 8000,
      log: () => {},
      remoteCwdForPane: (paneId) =>
        paneId === 'pane-remote' ? { host: 'db1', cwd: '/srv/app' } : undefined,
      remoteFolders: {
        windowOfWorkspace: (id) => owners.get(id),
        refusal: () => null,
        confirm,
        publish: (all) => published.push(all.forWindow('win1')),
      },
    })
    if (!host.remoteFolders) throw new Error('no remote folders')
    folders = host.remoteFolders
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  })

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    confirm.mockReset()
    confirm.mockResolvedValue(true)
    published.length = 0
  })

  async function open(path = '/srv/app'): Promise<string> {
    const res = await host.invoke(
      'shelf',
      'open',
      { workspaceId: 'w1', host: 'dev@db', path },
      caller,
    )
    const data = res.ok ? (res.data as { ok: boolean; folderId?: string }) : null
    if (!data?.folderId) throw new Error(JSON.stringify(res))
    return data.folderId
  }

  async function asked(): Promise<unknown[]> {
    const res = await host.invoke('shelf', 'asked', null, caller)
    return res.ok ? (res.data as unknown[]) : []
  }

  it('SSH-C58 opens a folder after core asked the human, naming the extension, host and path', async () => {
    const id = await open()
    expect(id).toMatch(/^[a-z0-9]{12}$/)
    expect(confirm).toHaveBeenCalledWith({
      extId: 'shelf',
      workspaceId: 'w1',
      extName: 'Shelf',
      host: 'dev@db',
      path: '/srv/app',
    })
    expect(published.at(-1)).toEqual([
      { id, workspaceId: 'w1', extId: 'shelf', extName: 'Shelf', host: 'dev@db', root: '/srv/app' },
    ])
    folders.closeByExtension('shelf', id)
  })

  it('SSH-C59 registers nothing when the human says no', async () => {
    confirm.mockResolvedValue(false)
    const res = await host.invoke(
      'shelf',
      'open',
      { workspaceId: 'w1', host: 'dev@db', path: '/srv/denied' },
      caller,
    )
    expect(res).toMatchObject({ ok: true, data: { ok: false, error: 'denied' } })
    expect(folders.forWindow('win1')).toEqual([])
    expect(published).toEqual([])
  })

  it('reads, lists and writes through the extension, giving it only the root and the path', async () => {
    const id = await open()
    await asked()
    const file = `remote://${id}/srv/app/notes.txt`
    expect(await folders.read('win1', file)).toEqual({
      ok: true,
      content: 'hello\n',
      version: '1-6',
    })
    expect(await folders.list('win1', `remote://${id}/srv/app`)).toEqual({
      ok: true,
      entries: [
        { name: 'notes.txt', dir: false },
        { name: 'src', dir: true },
      ],
      truncated: false,
    })
    expect(await folders.write('win1', file, 'changed\n', '0-0')).toEqual({
      ok: false,
      error: 'changed',
    })
    expect(await folders.write('win1', file, 'changed\n', '1-6')).toEqual({
      ok: true,
      version: '2-8',
    })
    expect(await folders.stat('win1', file)).toEqual({ ok: true, kind: 'file', version: '2-8' })
    expect(await asked()).toEqual([
      { op: 'read', folderId: id, root: '/srv/app', path: '/srv/app/notes.txt' },
      { op: 'list', folderId: id, root: '/srv/app', path: '/srv/app' },
      { op: 'write', folderId: id, root: '/srv/app', path: '/srv/app/notes.txt' },
      { op: 'write', folderId: id, root: '/srv/app', path: '/srv/app/notes.txt' },
      { op: 'stat', folderId: id, root: '/srv/app', path: '/srv/app/notes.txt' },
    ])
    folders.closeByExtension('shelf', id)
  })

  it('SSH-C62 never asks the extension about a path outside the folder', async () => {
    const id = await open()
    await asked()
    expect(await folders.read('win1', `remote://${id}/etc/passwd`)).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await folders.read('win1', `remote://${id}/srv/app/../../etc/passwd`)).toEqual({
      ok: false,
      error: 'invalid-path',
    })
    expect(await folders.read('other-window', `remote://${id}/srv/app/notes.txt`)).toEqual({
      ok: false,
      error: 'unknown-folder',
    })
    expect(await asked()).toEqual([])
    folders.closeByExtension('shelf', id)
  })

  it('SSH-C63 cleans a hostile listing, refuses NUL content and a bad version, and times a silent extension out', async () => {
    const id = await open()
    expect(await folders.list('win1', `remote://${id}/srv/app/hostile`)).toEqual({
      ok: true,
      entries: [{ name: 'fine.txt', dir: false }],
      truncated: false,
    })
    expect(await folders.read('win1', `remote://${id}/srv/app/nul.bin`)).toEqual({
      ok: false,
      error: 'binary',
    })
    expect(await folders.read('win1', `remote://${id}/srv/app/odd-version`)).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(await folders.read('win1', `remote://${id}/srv/app/slow`)).toEqual({
      ok: false,
      error: 'unavailable',
    })
    folders.closeByExtension('shelf', id)
  })

  it('SSH-C60 tells the extension when the human or the workspace closed a folder, and lets it close its own', async () => {
    const first = await open('/srv/one')
    const second = await open('/srv/two')
    const third = await open('/srv/three')
    expect(folders.closeByWindow('win1', first)).toBe(true)
    const own = await host.invoke('shelf', 'close', { folderId: second }, caller)
    expect(own).toEqual({ ok: true, data: { ok: true } })
    const unknown = await host.invoke('shelf', 'close', { folderId: 'nosuchfolder' }, caller)
    expect(unknown).toMatchObject({ ok: true, data: { ok: false, error: 'unknown-folder' } })
    folders.workspaceClosed('w1')
    expect(folders.forWindow('win1')).toEqual([])
    await expect
      .poll(async () => {
        const res = await host.invoke('shelf', 'closed', null, caller)
        return res.ok ? res.data : null
      })
      .toEqual([first, third])
    expect(published.at(-1)).toEqual([])
  })

  it('SSH-C61 gives a pane caller the remote folder its shell reported', () => {
    const remote = registerPane({ windowId: 'win1', workspaceId: 'w1', paneId: 'pane-remote' })
    const local = registerPane({ windowId: 'win1', workspaceId: 'w1', paneId: 'pane-local' })
    expect(host.paneCaller(remote).remote).toEqual({ host: 'db1', cwd: '/srv/app' })
    expect(host.paneCaller(local).remote).toBeUndefined()
  })

  it('SSH-C60 drops every folder of an extension that stops', async () => {
    await open('/srv/last')
    expect(folders.forWindow('win1')).toHaveLength(1)
    host.setEnabled('shelf', false)
    expect(folders.forWindow('win1')).toEqual([])
    expect(published.at(-1)).toEqual([])
  })
})
