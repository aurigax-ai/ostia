import type { ServerActionResult, ServerInviteResult } from '../../shared/server/serverApi'
import { failureOf, type ServerAccount } from './serverAccount'

type DevicesAccount = Pick<ServerAccount, 'authed' | 'signer'>

export class ServerDevices {
  constructor(private readonly account: DevicesAccount) {}

  async createInvite(): Promise<ServerInviteResult> {
    try {
      const invite = await this.account.authed((token, routes) =>
        this.account.signer().signed('invite', (headers) => routes.createInvite(token, headers)),
      )
      return { ok: true, ...invite }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }

  async revoke(deviceId: string): Promise<ServerActionResult> {
    try {
      await this.account.authed((token, routes) =>
        routes.revokeDevice(token, deviceId, this.account.signer().revoke(deviceId)),
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, error: failureOf(error) }
    }
  }
}
