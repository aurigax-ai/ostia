import type { ServerActionResult, ServerInviteResult } from '../../shared/server/serverApi'
import { failureOf, type ServerAccount } from './serverAccount'

type DevicesAccount = Pick<ServerAccount, 'authed' | 'signer'>

export class ServerDevices {
  constructor(private readonly account: DevicesAccount) {}

  async markSeen(deviceId: string): Promise<ServerActionResult> {
    try {
      const sig = this.account.signer().seen(deviceId)
      await this.account.authed((token, routes) => routes.markSeen(token, deviceId, sig))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  async createInvite(): Promise<ServerInviteResult> {
    try {
      const invite = await this.account.authed((token, routes) =>
        routes.createInvite(token, this.account.signer().stamped('invite')),
      )
      return { ok: true, ...invite }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  async revoke(deviceId: string): Promise<ServerActionResult> {
    try {
      const headers = this.account.signer().revoke(deviceId)
      await this.account.authed((token, routes) => routes.revokeDevice(token, deviceId, headers))
      return { ok: true }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }
}
