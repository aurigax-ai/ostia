import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeServer } from '../../../../test/fixtures/server/fakeServer'
import {
  firstDevice,
  joinedDevice,
  PASSPHRASE,
  type SyncDevice,
  setUp,
} from '../../../../test/fixtures/server/syncHarness'
import { digestOf } from '../../server/deviceKeys'
import { createServerClient, ServerError } from '../../server/serverClient'
import { FolderMethod } from '../folderMethod'
import { PROFILE_FOLDERS, SECRETS_FILE } from '../profile'
import { readRemote } from './syncRemote'

const servers: FakeServer[] = []
const devices: SyncDevice[] = []
const roots: string[] = []

async function world(options: ConstructorParameters<typeof FakeServer>[0] = {}) {
  const server = await new FakeServer(options).start()
  servers.push(server)
  const first = await firstDevice(server)
  devices.push(first)
  await setUp(first)
  return { server, first }
}

async function second(server: FakeServer, first: SyncDevice): Promise<SyncDevice> {
  const device = await joinedDevice(server, first)
  devices.push(device)
  expect(await device.keyring.unlock(PASSPHRASE)).toEqual({ ok: true })
  return device
}

afterEach(async () => {
  for (const device of devices.splice(0)) await device.close()
  for (const server of servers.splice(0)) await server.close()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const remoteSettings = async (device: SyncDevice): Promise<Record<string, unknown>> => {
  const remote = await readRemote({ account: device.account, keyring: device.keyring })
  return JSON.parse(remote.files.get('settings.json')?.toString('utf8') ?? '{}')
}

describe('ServerMethod through the profile sync engine', () => {
  it('SSY-C20 carries settings and every profile folder between two devices', async () => {
    const { server, first } = await world()
    const other = await second(server, first)
    first.writeSettings({ appearance: { theme: 'dark' } }, 1)
    for (const folder of PROFILE_FOLDERS) {
      const name =
        folder.name === 'snippets' ? 'a.yaml' : folder.name === 'completions' ? 'ls.json' : 'v.json'
      first.writeFile(`${folder.name}/${name}`, folder.name === 'snippets' ? 'a: 1\n' : '{}\n', 1)
    }
    const pushed = await first.sync.run()
    expect(pushed.status.state).toBe('ok')
    expect(pushed.status.dir).toBe(first.target.label())
    const pulled = await other.sync.run()
    expect(pulled.status.state).toBe('ok')
    expect(other.settings()).toMatchObject({ appearance: { theme: 'dark' } })
    expect(other.file('snippets/a.yaml')).toBe('a: 1\n')
    expect(other.file('completions/ls.json')).toBe('{}\n')
    expect(other.file('views/v.json')).toBe('{}\n')
  })

  it('SSY-C21 never uploads local-only roots or fields', async () => {
    const { first } = await world()
    first.writeSettings(
      {
        appearance: { theme: 'dark' },
        sync: { dir: '/home/me/Sync', method: 'server' },
        capabilities: { 'all-workspaces': 'allow' },
        approvals: { mode: 'ask' },
        playbooks: { enabled: ['x'], accepted: ['y'], shared: ['z'] },
      },
      1,
    )
    await first.sync.run()
    const settings = await remoteSettings(first)
    expect(settings).toMatchObject({ appearance: { theme: 'dark' }, playbooks: { shared: ['z'] } })
    expect(settings).not.toHaveProperty('sync')
    expect(settings).not.toHaveProperty('capabilities')
    expect(settings).not.toHaveProperty('approvals')
    expect(settings.playbooks).not.toHaveProperty('enabled')
    expect(settings.playbooks).not.toHaveProperty('accepted')
  })

  it('SSY-C22 keeps a second device own playbook switches while syncing playbooks', async () => {
    const { server, first } = await world()
    const other = await second(server, first)
    first.writeSettings({ playbooks: { enabled: ['a'], shared: ['one'] } }, 1)
    await first.sync.run()
    other.writeSettings({ playbooks: { enabled: ['b'] } }, 2)
    await other.sync.run()
    expect(other.settings().playbooks).toEqual({ enabled: ['b'], shared: ['one'] })
    await first.sync.run()
    expect(first.settings().playbooks).toEqual({ enabled: ['a'], shared: ['one'] })
  })

  it('SSY-C23 merges after a 412, newest change winning without asking', async () => {
    const { server, first } = await world()
    const other = await second(server, first)
    first.writeSettings({ appearance: { theme: 'dark' }, locale: 'en' }, 1)
    await first.sync.run()
    await other.sync.run()
    first.writeSettings({ appearance: { theme: 'light' }, locale: 'en' }, 2)
    other.writeSettings({ appearance: { theme: 'solar' }, locale: 'fr' }, 3)
    await first.sync.run()
    const result = await other.sync.run()
    expect(result.status.state).toBe('ok')
    expect(other.settings().appearance).toEqual({ theme: 'solar' })
    await first.sync.run()
    expect(first.settings().locale).toBe('fr')
  })

  it('SSY-C24 refuses an older manifest than the highest counter this device saw', async () => {
    const { server, first } = await world()
    first.writeSettings({ locale: 'en' }, 1)
    await first.sync.run()
    first.writeSettings({ locale: 'fr' }, 2)
    await first.sync.run()
    const account = server.devices.get('device1')?.accountId ?? ''
    server.syncData.get(account)?.manifests.pop()
    const stale = await first.sync.run()
    expect(stale.status.state).toBe('error')
    expect(stale.status.error).toBe('stale-manifest')
  })

  it('SSY-C25 reports the sync states as engine errors', async () => {
    const { first } = await world()
    first.keyring.forget()
    expect((await first.sync.run()).status.error).toBe('server-locked')
    await first.account.signOut()
    expect((await first.sync.run()).status.error).toBe('server-signed-out')
  })
})

describe('ServerMethod file parity with FolderMethod', () => {
  it('SSY-C26 returns the same file set a folder holds, secrets.enc included', async () => {
    const { first } = await world()
    const root = mkdtempSync(join(tmpdir(), 'folder-parity-'))
    roots.push(root)
    const files = new Map<string, string>([
      ['settings.json', '{"a":1}\n'],
      ['profile.json', '{"times":{}}\n'],
      ['extensions.json', '{"extensions":[]}\n'],
      [SECRETS_FILE, '{"header":{},"data":"x"}\n'],
      ['snippets/one.yaml', 'a: 1\n'],
      ['completions/git.json', '{}\n'],
      ['views/panel.json', '{}\n'],
    ])
    for (const [path, text] of files) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const folder = await new FolderMethod(root, []).read()
    const method = first.target.method()
    const empty = await method.read()
    expect(empty.version).toBe('1')
    expect((await method.write(folder.files, empty.version)).ok).toBe(true)
    const served = await method.read()
    expect(new Map([...served.files].sort())).toEqual(new Map([...folder.files].sort()))
    expect(served.skipped).toEqual(folder.skipped)
    expect([...served.files.keys()]).toContain(SECRETS_FILE)
    for (const folderRule of PROFILE_FOLDERS) {
      expect([...served.files.keys()].some((p) => p.startsWith(`${folderRule.name}/`))).toBe(true)
    }
  })

  it('SSY-C27 answers a stale version with a lost write', async () => {
    const { first } = await world()
    const method = first.target.method()
    const empty = await method.read()
    const settings = new Map([['settings.json', '{"a":1}\n']])
    expect(await method.write(settings, empty.version)).toEqual({ ok: true, version: '2' })
    expect(await method.write(settings, '1')).toEqual({ ok: false })
  })

  it('SSY-C161 refuses a stolen token on the passphrase wrap and the manifest push, and a replayed stamp', async () => {
    const { first } = await world()
    const refusal = async (use: () => Promise<unknown>): Promise<string> =>
      use().then(
        () => 'accepted',
        (error: unknown) => (error instanceof ServerError ? error.code : 'other'),
      )
    const client = createServerClient({ baseUrl: () => first.account.baseUrl() })
    const unsigned = () =>
      first.account.authed((token) => client.request('GET', '/v1/sync/wraps/passphrase', { token }))
    const read = (headers: Record<string, string>) =>
      first.account.authed((token, routes) => routes.secretWrap(token, 'passphrase', headers))
    const push = (headers: Record<string, string>) =>
      first.account.authed((token, routes) => routes.putManifest(token, 'AAAA', '1', headers))
    expect(await refusal(unsigned)).toBe('device-signature-required')
    expect(await refusal(() => push({}))).toBe('device-signature-required')
    let stamped: Record<string, string> = {}
    await first.account.signer().signed(
      'wrapRead',
      async (headers) => {
        stamped = headers
      },
      ['passphrase'],
    )
    expect(await refusal(() => read(stamped))).toBe('accepted')
    expect(await refusal(() => read(stamped))).toBe('stale-signature')
    expect(await refusal(() => push(stamped))).toBe('bad-signature')
    const signer = first.account.signer()
    const readSigned = (bound: string) =>
      signer.signed('wrapRead', (headers) => read(headers), [bound])
    expect(await refusal(() => readSigned('recovery'))).toBe('bad-signature')
    expect(await refusal(() => readSigned('passphrase'))).toBe('accepted')
    const json = JSON.stringify({ blob: 'AAAA' })
    const pushSigned = (ifMatch: string, body: string) =>
      signer.signed(
        'manifestPut',
        (headers) =>
          first.account.authed((token, routes) => routes.putManifest(token, json, '1', headers)),
        [ifMatch, digestOf(body)],
      )
    expect(await refusal(() => pushSigned('2', json))).toBe('bad-signature')
    expect(await refusal(() => pushSigned('1', `${json} `))).toBe('bad-signature')
    expect(await refusal(() => pushSigned('1', json))).toBe('accepted')
  })

  it('SSY-C171 takes a fresh stamp for the write that follows a 412 on a signed push', async () => {
    const { server, first } = await world()
    const method = first.target.method()
    const settings = new Map([['settings.json', '{"a":1}\n']])
    const empty = await method.read()
    expect(await method.write(settings, empty.version)).toEqual({ ok: true, version: '2' })
    const device = [...server.devices.values()][0]
    const before = device?.lastStamp ?? 0
    expect(await method.write(settings, '1')).toEqual({ ok: false })
    expect(device?.lastStamp ?? 0).toBeGreaterThan(before)
    expect(await method.write(settings, '2')).toEqual({ ok: true, version: '3' })
  })

  it('SSY-C28 lists an oversize remote file as skipped and maps a server limit to a quota error', async () => {
    const { first } = await world({ maxBlobBytes: 2 * 1024 * 1024 })
    const method = first.target.method()
    const huge = `{"a":"${'x'.repeat(1024 * 1024 + 10)}"}\n`
    await method.write(
      new Map([
        ['settings.json', huge],
        ['profile.json', '{}\n'],
      ]),
      '1',
    )
    const served = await method.read()
    expect(served.skipped).toEqual(['settings.json'])
    expect([...served.files.keys()]).toEqual(['profile.json'])
    const tooBig = new Map([['profile.json', 'y'.repeat(3 * 1024 * 1024)]])
    await expect(method.write(tooBig, served.version)).rejects.toMatchObject({
      code: 'server-quota',
    })
  })
})
