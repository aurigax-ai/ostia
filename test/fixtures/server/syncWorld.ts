import { expect } from 'vitest'
import { FakeServer, type FakeServerOptions } from './fakeServer'
import { firstDevice, joinedDevice, PASSPHRASE, type SyncDevice, setUp } from './syncHarness'

export function syncWorld() {
  const servers: FakeServer[] = []
  const devices: SyncDevice[] = []
  return {
    async world(options: FakeServerOptions = { approverMinAgeMs: 0 }) {
      const server = await new FakeServer(options).start()
      servers.push(server)
      const first = await firstDevice(server)
      devices.push(first)
      const recoveryKey = await setUp(first)
      return { server, first, recoveryKey }
    },
    async join(
      server: FakeServer,
      via: SyncDevice,
      unlock = true,
      approver?: SyncDevice,
    ): Promise<SyncDevice> {
      const device = await joinedDevice(server, via, approver)
      devices.push(device)
      if (unlock) expect((await device.service.unlock(PASSPHRASE)).ok).toBe(true)
      return device
    },
    track(server: FakeServer, device: SyncDevice): void {
      servers.push(server)
      devices.push(device)
    },
    async close(): Promise<void> {
      for (const device of devices.splice(0)) await device.close()
      for (const server of servers.splice(0)) await server.close()
    },
  }
}
