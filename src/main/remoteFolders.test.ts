import { describe, expect, it, vi } from 'vitest'
import type { RemoteFilesRequest, RemoteFolder } from '../shared/remoteFolders'
import { type RemoteFolderConfirm, RemoteFolders } from './remoteFolders'

const EXT = { id: 'shelf', name: 'Shelf' }

function setup(over: { approve?: boolean } = {}) {
  const owners = new Map([
    ['w1', 'win1'],
    ['w2', 'win2'],
    ['boxed', 'win1'],
    ['scratch', 'win1'],
  ])
  const confirms: RemoteFolderConfirm[] = []
  const requests: RemoteFilesRequest[] = []
  const closed: RemoteFolder[] = []
  const publish = vi.fn()
  let reply: unknown = { ok: true, entries: [{ name: 'a.txt', dir: false }] }
  let next = 0
  const folders = new RemoteFolders({
    windowOfWorkspace: (id) => owners.get(id),
    refusal: (id) => (id === 'boxed' ? 'sandboxed' : id === 'scratch' ? 'scratch' : null),
    confirm: async (req) => {
      confirms.push(req)
      return over.approve ?? true
    },
    request: async (_extId, req) => {
      requests.push(req)
      if (reply instanceof Error) throw reply
      return reply
    },
    closed: (folder) => closed.push(folder),
    publish,
    newId: () => `folder${String(++next).padStart(6, '0')}`,
  })
  return {
    folders,
    owners,
    confirms,
    requests,
    closed,
    publish,
    answer: (value: unknown) => {
      reply = value
    },
  }
}

async function opened(s: ReturnType<typeof setup>, workspaceId = 'w1', path = '/srv/app') {
  const res = await s.folders.open(EXT, { workspaceId, host: 'dev@db', path })
  if (!res.ok) throw new Error(res.error)
  return res.folderId
}

describe('RemoteFolders.open', () => {
  it('SSH-C58 registers a folder for the owning window after the human approved host and path', async () => {
    const s = setup()
    const res = await s.folders.open(EXT, {
      workspaceId: 'w1',
      host: 'dev@db:2200',
      path: '/srv//app/',
    })
    expect(res).toEqual({ ok: true, folderId: 'folder000001' })
    expect(s.confirms).toEqual([
      {
        extId: 'shelf',
        workspaceId: 'w1',
        extName: 'Shelf',
        host: 'dev@db:2200',
        path: '/srv/app',
      },
    ])
    expect(s.folders.forWindow('win1')).toEqual([
      {
        id: 'folder000001',
        workspaceId: 'w1',
        extId: 'shelf',
        extName: 'Shelf',
        host: 'dev@db:2200',
        root: '/srv/app',
      },
    ])
    expect(s.folders.forWindow('win2')).toEqual([])
    expect(s.publish).toHaveBeenCalledTimes(1)
  })

  it('returns the folder that is already open without asking again', async () => {
    const s = setup()
    const first = await opened(s)
    expect(await opened(s)).toBe(first)
    expect(s.confirms).toHaveLength(1)
  })

  it('SSH-C59 refuses a denied dialog, unknown, scratch and sandboxed workspaces, bad hosts and paths', async () => {
    const denied = setup({ approve: false })
    expect(
      await denied.folders.open(EXT, { workspaceId: 'w1', host: 'db', path: '/srv' }),
    ).toMatchObject({
      ok: false,
      error: 'denied',
    })
    expect(denied.folders.forWindow('win1')).toEqual([])
    expect(denied.publish).not.toHaveBeenCalled()

    const s = setup()
    const attempts: [unknown, string][] = [
      [{ workspaceId: 'nope', host: 'db', path: '/srv' }, 'unknown-workspace'],
      [{ host: 'db', path: '/srv' }, 'unknown-workspace'],
      [{ workspaceId: 'boxed', host: 'db', path: '/srv' }, 'sandboxed'],
      [{ workspaceId: 'scratch', host: 'db', path: '/srv' }, 'scratch'],
      [{ workspaceId: 'w1', host: 'db host', path: '/srv' }, 'invalid-params'],
      [{ workspaceId: 'w1', host: 'db;reboot', path: '/srv' }, 'invalid-params'],
      [{ workspaceId: 'w1', host: 'db', path: 'srv' }, 'invalid-params'],
      [{ workspaceId: 'w1', host: 'db', path: '/srv/../etc' }, 'invalid-params'],
      [{ workspaceId: 'w1', host: 'db', path: '/a\nb' }, 'invalid-params'],
      [null, 'unknown-workspace'],
    ]
    for (const [params, error] of attempts) {
      expect(await s.folders.open(EXT, params), JSON.stringify(params)).toMatchObject({
        ok: false,
        error,
      })
    }
    expect(s.confirms).toEqual([])
    expect(s.folders.forWindow('win1')).toEqual([])
  })

  it('SSH-C59 holds at most eight folders per workspace', async () => {
    const s = setup()
    for (let i = 0; i < 8; i++) await opened(s, 'w1', `/srv/app${i}`)
    expect(
      await s.folders.open(EXT, { workspaceId: 'w1', host: 'dev@db', path: '/srv/more' }),
    ).toMatchObject({
      ok: false,
      error: 'too-many',
    })
    expect(s.confirms).toHaveLength(8)
    expect(await opened(s, 'w2', '/srv/more')).toBe('folder000009')
  })

  it('drops the folder when the workspace closed while the human was asked', async () => {
    const s = setup()
    const pending = s.folders.open(EXT, { workspaceId: 'w1', host: 'db', path: '/srv' })
    s.owners.delete('w1')
    expect(await pending).toMatchObject({ ok: false, error: 'unknown-workspace' })
  })
})

describe('RemoteFolders close', () => {
  it('SSH-C60 closes for the human of the owning window, the workspace, and the extension', async () => {
    const s = setup()
    const a = await opened(s, 'w1', '/a')
    const b = await opened(s, 'w1', '/b')
    const c = await opened(s, 'w2', '/c')
    expect(s.folders.closeByWindow('win2', a)).toBe(false)
    expect(s.folders.closeByWindow('win1', a)).toBe(true)
    expect(s.closed.map((f) => f.id)).toEqual([a])
    expect(s.folders.closeByExtension('other', b)).toBe(false)
    expect(s.folders.closeByExtension('shelf', b)).toBe(true)
    expect(s.closed.map((f) => f.id)).toEqual([a])
    s.folders.workspaceClosed('w2')
    expect(s.closed.map((f) => f.id)).toEqual([a, c])
    expect(s.folders.forWindow('win1')).toEqual([])
    expect(s.folders.forWindow('win2')).toEqual([])
    const d = await opened(s, 'w1', '/d')
    s.folders.extensionGone('shelf')
    expect(s.folders.forWindow('win1')).toEqual([])
    expect(s.closed.map((f) => f.id)).not.toContain(d)
  })

  it('follows the workspace to the window that owns it now', async () => {
    const s = setup()
    const id = await opened(s)
    s.owners.set('w1', 'win2')
    expect(s.folders.forWindow('win1')).toEqual([])
    expect(s.folders.forWindow('win2').map((f) => f.id)).toEqual([id])
    expect(await s.folders.list('win1', `remote://${id}/srv/app`)).toEqual({
      ok: false,
      error: 'unknown-folder',
    })
  })
})

describe('RemoteFolders files', () => {
  it('asks the extension with the folder root and the normalized path', async () => {
    const s = setup()
    const id = await opened(s)
    expect(await s.folders.list('win1', `remote://${id}/srv/app//src/`)).toEqual({
      ok: true,
      entries: [{ name: 'a.txt', dir: false }],
      truncated: false,
    })
    expect(s.requests).toEqual([
      { op: 'list', folderId: id, root: '/srv/app', path: '/srv/app/src' },
    ])
  })

  it('SSH-C62 refuses paths outside the folder, bad paths and other windows without asking the extension', async () => {
    const s = setup()
    const id = await opened(s)
    const bad: [string, unknown, string][] = [
      ['win1', `remote://${id}/srv/application/x`, 'outside'],
      ['win1', `remote://${id}/etc/passwd`, 'outside'],
      ['win1', `remote://${id}/srv/app/../../etc/passwd`, 'invalid-path'],
      ['win1', `remote://${id}/srv/app/a\u0000b`, 'invalid-path'],
      ['win1', '/srv/app/x', 'invalid-path'],
      ['win1', 'remote://nosuchfolder/srv/app', 'unknown-folder'],
      ['win1', { path: '/srv/app' }, 'invalid-path'],
      ['win2', `remote://${id}/srv/app/x`, 'unknown-folder'],
    ]
    for (const [windowId, path, error] of bad) {
      const failure = { ok: false, error }
      expect(await s.folders.list(windowId, path), String(path)).toEqual(failure)
      expect(await s.folders.stat(windowId, path)).toEqual(failure)
      expect(await s.folders.read(windowId, path)).toEqual(failure)
      expect(await s.folders.write(windowId, path, 'x', 'any')).toEqual(failure)
    }
    expect(s.requests).toEqual([])
  })

  it('validates what the extension answers and reports a dead extension as unavailable', async () => {
    const s = setup()
    const id = await opened(s)
    const file = `remote://${id}/srv/app/a.txt`
    s.answer({ ok: true, content: 'text', version: '5-4' })
    expect(await s.folders.read('win1', file)).toEqual({
      ok: true,
      content: 'text',
      version: '5-4',
    })
    s.answer({ ok: true, content: 'a\u0000', version: '5-4' })
    expect(await s.folders.read('win1', file)).toEqual({ ok: false, error: 'binary' })
    s.answer({ ok: true, kind: 'file', version: '5-4' })
    expect(await s.folders.stat('win1', file)).toEqual({ ok: true, kind: 'file', version: '5-4' })
    s.answer(new Error('gone'))
    expect(await s.folders.read('win1', file)).toEqual({ ok: false, error: 'unavailable' })
  })

  it('writes text with a base version and refuses anything else before asking', async () => {
    const s = setup()
    const id = await opened(s)
    const file = `remote://${id}/srv/app/a.txt`
    s.answer({ ok: true, version: '7-3' })
    expect(await s.folders.write('win1', file, 'new', '5-4')).toEqual({ ok: true, version: '7-3' })
    expect(s.requests.at(-1)).toEqual({
      op: 'write',
      folderId: id,
      root: '/srv/app',
      path: '/srv/app/a.txt',
      content: 'new',
      baseVersion: '5-4',
    })
    const asked = s.requests.length
    expect(await s.folders.write('win1', file, 'a\u0000', '5-4')).toEqual({
      ok: false,
      error: 'binary',
    })
    expect(await s.folders.write('win1', file, 7, '5-4')).toEqual({ ok: false, error: 'binary' })
    expect(await s.folders.write('win1', file, 'x'.repeat(3 * 1024 * 1024), '5-4')).toEqual({
      ok: false,
      error: 'too-large',
    })
    expect(await s.folders.write('win1', file, 'x', 'not a version')).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(await s.folders.write('win1', file, 'x', undefined)).toEqual({
      ok: false,
      error: 'failed',
    })
    expect(s.requests).toHaveLength(asked)
    s.answer({ ok: false, error: 'changed' })
    expect(await s.folders.write('win1', file, 'x', 'new')).toEqual({ ok: false, error: 'changed' })
  })
})
