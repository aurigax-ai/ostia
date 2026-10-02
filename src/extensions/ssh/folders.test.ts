import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type RemoteHost, helperSource, remoteHost } from '../../../test/fixtures/ssh/remoteHost'
import type { RemoteFilesRequest, RemoteFilesResult } from '../sdk'
import { HelperFolders, Sessions, parseListing } from './folders'
import { shippedHelper, versionToken } from './helper'
import { HelperHosts } from './helperHosts'
import { type ConnectPlan, planConnect } from './plan'

const helper = shippedHelper(helperSource())

function planned(argv: string[]): ConnectPlan {
  const plan = planConnect(argv)
  if (!plan) throw new Error('plan')
  return plan
}

const plan = planned(['dev@db'])
const ID = 'folder000001'

interface Rig {
  remote: RemoteHost
  hosts: HelperHosts
  folders: HelperFolders
  root: string
  ask: (req: Omit<RemoteFilesRequest, 'folderId' | 'root'>) => Promise<RemoteFilesResult>
}

const rigs: Rig[] = []

async function rig(): Promise<Rig> {
  const remote = remoteHost()
  const hosts = new HelperHosts({ helper, spawn: remote.spawn })
  await hosts.install(plan)
  const folders = new HelperFolders(hosts)
  const root = join(remote.home, 'app')
  mkdirSync(root)
  folders.add(ID, plan)
  const made: Rig = {
    remote,
    hosts,
    folders,
    root,
    ask: async (req) => folders.handle({ ...req, folderId: ID, root }),
  }
  rigs.push(made)
  return made
}

afterEach(() => {
  for (const made of rigs.splice(0)) {
    made.hosts.closeAll()
    made.remote.cleanup()
  }
})

describe('Sessions', () => {
  it('remembers the plan of a pane the extension opened until the pane closes', () => {
    const sessions = new Sessions()
    sessions.opened('p1', plan)
    expect(sessions.planOf('p1')).toBe(plan)
    expect(sessions.planOf('p2')).toBeUndefined()
    expect(sessions.planOf(undefined)).toBeUndefined()
    sessions.closed('p1')
    expect(sessions.planOf('p1')).toBeUndefined()
  })
})

describe('parseListing', () => {
  it('keeps only lines that name a file or a folder', () => {
    expect(parseListing(Buffer.from('d src\nf a b.txt\nx odd\nf \n\nd  lead\n'))).toEqual([
      { name: 'src', dir: true },
      { name: 'a b.txt', dir: false },
      { name: ' lead', dir: true },
    ])
  })
})

describe('HelperFolders', () => {
  it('lists, stats, reads and writes a folder through the helper', async () => {
    const r = await rig()
    mkdirSync(join(r.root, 'src'))
    writeFileSync(join(r.root, 'readme.md'), '# hi\n')
    expect(await r.ask({ op: 'list', path: r.root })).toEqual({
      ok: true,
      entries: [
        { name: 'readme.md', dir: false },
        { name: 'src', dir: true },
      ],
      truncated: false,
    })
    const version = versionToken(Buffer.from('# hi\n'))
    expect(await r.ask({ op: 'stat', path: join(r.root, 'readme.md') })).toEqual({
      ok: true,
      kind: 'file',
      version,
    })
    expect(await r.ask({ op: 'stat', path: join(r.root, 'src') })).toEqual({
      ok: true,
      kind: 'dir',
    })
    expect(await r.ask({ op: 'read', path: join(r.root, 'readme.md') })).toEqual({
      ok: true,
      content: '# hi\n',
      version,
    })
    const next = '# 你好\n'
    expect(
      await r.ask({
        op: 'write',
        path: join(r.root, 'readme.md'),
        content: next,
        baseVersion: version,
      }),
    ).toEqual({ ok: true, version: versionToken(Buffer.from(next)) })
    expect(readFileSync(join(r.root, 'readme.md'), 'utf8')).toBe(next)
    expect(
      await r.ask({
        op: 'write',
        path: join(r.root, 'readme.md'),
        content: 'stale',
        baseVersion: version,
      }),
    ).toEqual({ ok: false, error: 'changed' })
  })

  it('reports binary files, missing files and paths outside the folder as errors', async () => {
    const r = await rig()
    writeFileSync(join(r.root, 'image.bin'), Buffer.from([0x89, 0x50, 0x00, 0xff]))
    writeFileSync(join(r.root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]))
    writeFileSync(join(r.remote.home, 'secret'), 'secret')
    symlinkSync(join(r.remote.home, 'secret'), join(r.root, 'link'))
    expect(await r.ask({ op: 'read', path: join(r.root, 'image.bin') })).toEqual({
      ok: false,
      error: 'binary',
    })
    expect(await r.ask({ op: 'read', path: join(r.root, 'latin1.txt') })).toEqual({
      ok: false,
      error: 'binary',
    })
    expect(await r.ask({ op: 'read', path: join(r.root, 'none') })).toEqual({
      ok: false,
      error: 'not-found',
    })
    expect(await r.ask({ op: 'read', path: join(r.root, 'link') })).toEqual({
      ok: false,
      error: 'outside',
    })
    expect(await r.ask({ op: 'read', path: join(r.remote.home, 'secret') })).toEqual({
      ok: false,
      error: 'outside',
    })
  })

  it('answers unknown-folder for a folder it does not hold and unavailable when the host is gone', async () => {
    const r = await rig()
    expect(
      await r.folders.handle({ op: 'list', folderId: 'other0000001', root: r.root, path: r.root }),
    ).toEqual({
      ok: false,
      error: 'unknown-folder',
    })
    await r.hosts.remove(plan)
    expect(await r.ask({ op: 'list', path: r.root })).toEqual({ ok: false, error: 'unavailable' })
    r.folders.remove(ID)
    expect(r.folders.idsOn('dev@db')).toEqual([])
  })
})
