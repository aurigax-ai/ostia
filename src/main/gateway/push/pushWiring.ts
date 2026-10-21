import type { Ask } from '../../approvals/asks'
import { getByPaneId } from '../../control/idRegistry'
import type { ServerAccount } from '../../server/serverAccount'
import { get as getDevice, list as listDevices, setDevicePush } from '../devices'
import { deviceConnected, sendDeviceConfig } from '../server'
import { PhonePush } from './phonePush'
import { WaitingSince } from './waitingSince'

interface PushWiringDeps {
  server: ServerAccount
  broadcast: (channel: string, payload: unknown) => void
  log: (event: string, fields: Record<string, string>) => void
  listAsks: () => Ask[]
}

export function startPhonePush({ server, broadcast, log, listAsks }: PushWiringDeps) {
  const waitingSince = new WaitingSince({
    now: Date.now,
    workspaceOf: (paneId) => getByPaneId(paneId)?.workspaceId,
  })
  const phonePush = new PhonePush({
    account: server,
    devices: { list: listDevices, get: getDevice, setPush: setDevicePush },
    connected: deviceConnected,
    needsHuman: async () => listAsks().length > 0 || waitingSince.any(),
    sendConfig: sendDeviceConfig,
    changed: () => broadcast('gateway:push-changed', null),
    log,
  })
  phonePush.start()
  return { phonePush, waitingSince }
}
