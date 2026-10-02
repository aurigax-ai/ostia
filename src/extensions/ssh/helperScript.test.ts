import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type RemoteHost,
  helperSource,
  remoteHost,
  toolPath,
} from '../../../test/fixtures/ssh/remoteHost'
import { HelperChannel, HelperFailure, runStatus } from './channel'
import { HELPER_TOOLS, helperBundle, versionToken } from './helper'
import { type ConnectPlan, planConnect, planHelper } from './plan'

const helper = helperBundle(helperSource())
function planned(argv: string[]): ConnectPlan {
  const plan = planConnect(argv)
  if (!plan) throw new Error('plan')
  return plan
}

const plan = planned(['dev@db'])

const hosts: RemoteHost[] = []
const channels: HelperChannel[] = []

function host(path?: string): RemoteHost {
  const made = remoteHost(path ? { path } : {})
  hosts.push(made)
  return made
}

afterEach(() => {
  for (const channel of channels.splice(0)) channel.close()
  for (const made of hosts.splice(0)) made.cleanup()
})

function install(remote: RemoteHost, bundle = helper): Promise<string[]> {
  return runStatus(planHelper(plan, 'install', bundle), bundle.source, { spawn: remote.spawn })
}

async function open(remote: RemoteHost): Promise<HelperChannel> {
  const channel = await HelperChannel.open(planHelper(plan, 'run', helper), {
    spawn: remote.spawn,
  })
  channels.push(channel)
  return channel
}

async function ready(): Promise<{ remote: RemoteHost; channel: HelperChannel; root: string }> {
  const remote = host()
  await install(remote)
  const root = join(remote.home, 'project')
  mkdirSync(root)
  return { remote, channel: await open(remote), root }
}

async function failure(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (err) {
    if (err instanceof HelperFailure) return err.code
    throw err
  }
  return 'no failure'
}

const LIST_MAX = 1024 * 1024

describe('helper install', () => {
  it('SSH-C42 installs the shipped script byte for byte into a private folder', async () => {
    const remote = host()
    expect(await install(remote)).toEqual(['installed'])
    const dir = join(remote.home, '.pine', 'helper', helper.version)
    expect(readFileSync(join(dir, 'helper.sh')).equals(helper.source)).toBe(true)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'helper.sh')).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['helper.sh'])
  })

  it('SSH-C43 reports a host without the helper, a changed helper and a missing tool', async () => {
    const remote = host()
    expect(await failure(open(remote))).toBe('missing')
    await install(remote)
    const file = join(remote.home, '.pine', 'helper', helper.version, 'helper.sh')
    writeFileSync(file, `${readFileSync(file, 'utf8')}echo changed\n`)
    expect(await failure(open(remote))).toBe('corrupt')

    const bare = host(toolPath(['sh', 'env', ...HELPER_TOOLS.filter((t) => t !== 'cksum')]))
    expect(await install(bare)).toEqual(['needs', 'cksum'])
    expect(existsSync(join(bare.home, '.pine'))).toBe(false)
  })

  it('SSH-C44 replaces an older version and removes everything it made', async () => {
    const remote = host()
    const older = helperBundle(Buffer.concat([helper.source, Buffer.from('\n')]))
    expect(await install(remote, older)).toEqual(['installed'])
    expect(await install(remote)).toEqual(['installed'])
    expect(readdirSync(join(remote.home, '.pine', 'helper'))).toEqual([helper.version])
    const removed = await runStatus(planHelper(plan, 'remove', helper), null, {
      spawn: remote.spawn,
    })
    expect(removed).toEqual(['removed'])
    expect(existsSync(join(remote.home, '.pine'))).toBe(false)
  })

  it('keeps ~/.pine when something else lives there', async () => {
    const remote = host()
    await install(remote)
    writeFileSync(join(remote.home, '.pine', 'keep'), 'mine')
    await runStatus(planHelper(plan, 'remove', helper), null, { spawn: remote.spawn })
    expect(readdirSync(join(remote.home, '.pine'))).toEqual(['keep'])
  })
})

describe('helper protocol', () => {
  it('SSH-C45 shakes hands past the noise a login prints first', async () => {
    const { remote, channel } = await ready()
    expect(channel.isClosed).toBe(false)
    expect(remote.runs().at(-1)).toContain('-T -- dev@db')
    const stage = readdirSync(join(remote.home, '.pine', 'helper', helper.version))
    expect(stage.some((name) => name.startsWith('run.'))).toBe(true)
  })

  it('SSH-C46 lists files, folders, hidden entries and links once each with their kind', async () => {
    const { channel, root } = await ready()
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'elsewhere'))
    writeFileSync(join(root, 'a file.txt'), 'a')
    writeFileSync(join(root, '.hidden'), 'h')
    writeFileSync(join(root, '..odd'), 'o')
    writeFileSync(join(root, 'line\nbreak'), 'n')
    symlinkSync(join(root, 'elsewhere'), join(root, 'link'))
    symlinkSync(join(root, 'nowhere'), join(root, 'dangling'))
    const reply = await channel.request({
      op: 'list',
      number: 100,
      root,
      path: root,
      maxReply: LIST_MAX,
    })
    expect(reply.meta).toBe('full')
    expect(reply.payload.toString('utf8').trimEnd().split('\n').sort()).toEqual(
      ['d elsewhere', 'd link', 'd src', 'f ..odd', 'f .hidden', 'f a file.txt'].sort(),
    )
    const cut = await channel.request({
      op: 'list',
      number: 2,
      root,
      path: root,
      maxReply: LIST_MAX,
    })
    expect(cut.meta).toBe('truncated')
    expect(cut.payload.toString('utf8').trimEnd().split('\n')).toHaveLength(2)
    const empty = await channel.request({
      op: 'list',
      number: 100,
      root,
      path: join(root, 'src'),
      maxReply: LIST_MAX,
    })
    expect(empty.payload.length).toBe(0)
  })

  it('SSH-C47 reads every byte value unchanged with a checksum version, and refuses past the cap', async () => {
    const { channel, root } = await ready()
    const bytes = Buffer.from(Uint8Array.from({ length: 200_000 }, (_, i) => (i * 7) % 256))
    writeFileSync(join(root, 'data.bin'), bytes)
    const reply = await channel.request({
      op: 'read',
      number: 1_000_000,
      root,
      path: join(root, 'data.bin'),
      maxReply: 1_000_000,
    })
    expect(reply.payload.equals(bytes)).toBe(true)
    expect(reply.meta).toBe(versionToken(bytes))
    const stat = await channel.request({
      op: 'stat',
      number: 1_000_000,
      root,
      path: join(root, 'data.bin'),
      maxReply: 0,
    })
    expect(stat.meta).toBe(`f:${bytes.length}:${versionToken(bytes)}`)
    const folder = await channel.request({ op: 'stat', number: 0, root, path: root, maxReply: 0 })
    expect(folder.meta).toBe('d')
    expect(
      await failure(
        channel.request({
          op: 'read',
          number: 1000,
          root,
          path: join(root, 'data.bin'),
          maxReply: 1000,
        }),
      ),
    ).toBe('too-large')
    expect(
      await failure(
        channel.request({ op: 'read', number: 10, root, path: join(root, 'none'), maxReply: 10 }),
      ),
    ).toBe('not-found')
    expect(
      await failure(channel.request({ op: 'read', number: 10, root, path: root, maxReply: 10 })),
    ).toBe('not-file')
  })

  it('SSH-C48 refuses anything outside the opened folder, also through a link', async () => {
    const { remote, channel, root } = await ready()
    const secret = join(remote.home, 'secret.txt')
    writeFileSync(secret, 'secret')
    mkdirSync(join(remote.home, 'outside'))
    symlinkSync(secret, join(root, 'link.txt'))
    symlinkSync(join(remote.home, 'outside'), join(root, 'out'))
    const read = (path: string): Promise<string> =>
      failure(channel.request({ op: 'read', number: 100, root, path, maxReply: 100 }))
    expect(await read(secret)).toBe('outside')
    expect(await read(join(root, '..', 'secret.txt'))).toBe('outside')
    expect(await read(join(root, 'link.txt'))).toBe('outside')
    expect(
      await failure(
        channel.request({
          op: 'list',
          number: 10,
          root,
          path: join(root, 'out'),
          maxReply: LIST_MAX,
        }),
      ),
    ).toBe('outside')
    const write = (path: string): Promise<string> =>
      failure(
        channel.request({
          op: 'write',
          number: 3,
          version: 'any',
          root,
          path,
          payload: Buffer.from('new'),
          maxReply: 0,
        }),
      )
    expect(await write(join(root, 'link.txt'))).toBe('outside')
    expect(await write(join(root, 'out', 'made.txt'))).toBe('outside')
    expect(await write(join(remote.home, 'made.txt'))).toBe('outside')
    expect(readFileSync(secret, 'utf8')).toBe('secret')
    expect(readdirSync(join(remote.home, 'outside'))).toEqual([])
    expect(existsSync(join(remote.home, 'made.txt'))).toBe(false)
    const still = await channel.request({ op: 'stat', number: 0, root, path: root, maxReply: 0 })
    expect(still.meta).toBe('d')
  })

  it('SSH-C66 writes through a temp file, keeps the mode and returns the new version', async () => {
    const { channel, root } = await ready()
    const file = join(root, 'run.sh')
    writeFileSync(file, 'echo one\n')
    chmodSync(file, 0o750)
    const before = versionToken(Buffer.from('echo one\n'))
    const next = Buffer.from('echo two\n\u0000ÿ binary too')
    const reply = await channel.request({
      op: 'write',
      number: next.length,
      version: before,
      root,
      path: file,
      payload: next,
      maxReply: 0,
    })
    expect(reply.meta).toBe(versionToken(next))
    expect(readFileSync(file).equals(next)).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o750)
    expect(readdirSync(root)).toEqual(['run.sh'])
    const made = await channel.request({
      op: 'write',
      number: 0,
      version: 'new',
      root,
      path: join(root, 'empty.txt'),
      maxReply: 0,
    })
    expect(made.meta).toBe(versionToken(Buffer.alloc(0)))
    expect(readFileSync(join(root, 'empty.txt'), 'utf8')).toBe('')
  })

  it('SSH-C67 refuses a write when the file changed since it was read, until asked to overwrite', async () => {
    const { channel, root } = await ready()
    const file = join(root, 'notes.txt')
    writeFileSync(file, 'theirs')
    const stale = versionToken(Buffer.from('mine before'))
    const write = (version: string) =>
      channel.request({
        op: 'write',
        number: 4,
        version,
        root,
        path: file,
        payload: Buffer.from('mine'),
        maxReply: 0,
      })
    expect(await failure(write(stale))).toBe('changed')
    expect(await failure(write('new'))).toBe('changed')
    expect(readFileSync(file, 'utf8')).toBe('theirs')
    expect(readdirSync(root)).toEqual(['notes.txt'])
    await write('any')
    expect(readFileSync(file, 'utf8')).toBe('mine')
  })

  it('answers a large write and the request after it in order', async () => {
    const { channel, root } = await ready()
    const big = Buffer.from(Uint8Array.from({ length: 1_500_000 }, (_, i) => (i * 13) % 256))
    const file = join(root, 'big.bin')
    const [written, listed] = await Promise.all([
      channel.request({
        op: 'write',
        number: big.length,
        version: 'new',
        root,
        path: file,
        payload: big,
        maxReply: 0,
      }),
      channel.request({ op: 'list', number: 10, root, path: root, maxReply: LIST_MAX }),
    ])
    expect(written.meta).toBe(versionToken(big))
    expect(readFileSync(file).equals(big)).toBe(true)
    expect(listed.payload.toString('utf8')).toBe('f big.bin\n')
  })

  it('removes its staging folder when the channel closes', async () => {
    const { remote, channel } = await ready()
    const dir = join(remote.home, '.pine', 'helper', helper.version)
    const closed = new Promise<void>((resolve) => channel.onClose(resolve))
    channel.close()
    await closed
    await expect.poll(() => readdirSync(dir), { timeout: 5000 }).toEqual(['helper.sh'])
  })
})
