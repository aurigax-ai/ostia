import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeServer } from '../../../test/fixtures/server/fakeServer'
import { FRIENDLY_NAME } from '../../shared/gateway/friendlyName'

const files = new Map<string, unknown>()

vi.mock('electron', () => ({
  app: { isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain),
    decryptString: (secret: Buffer) => secret.toString(),
  },
}))

vi.mock('../platform/jsonStore', () => ({
  storePath: (name: string) => name,
  loadJson: (path: string, fallback: unknown) => files.get(path) ?? fallback,
  saveJson: (path: string, data: unknown) => {
    files.set(path, data)
  },
}))

vi.mock('../updates/appVersion', () => ({ runningBuild: () => null }))
vi.mock('./serverIpc', () => ({ registerServerIpc: vi.fn() }))

const servers: FakeServer[] = []

afterEach(async () => {
  files.clear()
  for (const server of servers.splice(0)) await server.close()
})

describe('the device name sent to the server', () => {
  it('SSY-C133 registers the account device under the friendly name, never the machine hostname', async () => {
    const server = await new FakeServer().start()
    servers.push(server)
    server.invites.add('code-1')
    files.set('server-config', { url: server.url, identity: null })
    const { startServer } = await import('./serverWiring')
    const account = startServer({ broadcast: () => {}, openExternalSafe: () => false })
    expect((await account.signInWithInvite('code-1')).ok).toBe(true)
    const names = [...server.devices.values()].map((d) => d.name)
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(FRIENDLY_NAME)
  })
})
