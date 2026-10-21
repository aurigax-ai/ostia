import { type DeviceKeys, signApprove, signRevoke, signSeen, signStamped } from './deviceKeys'
import { ServerError } from './serverClient'

export interface SignerDeps {
  keys: () => DeviceKeys | null
  deviceId: () => string | null
  now?: () => number
}

export type SignedHeaders = Record<string, string>

export class DeviceSigner {
  private lastStamp = 0

  constructor(private readonly deps: SignerDeps) {}

  private who(): { keys: DeviceKeys; id: string } {
    const keys = this.deps.keys()
    const id = this.deps.deviceId()
    if (!keys || !id) throw new ServerError(0, 'not-signed-in')
    return { keys, id }
  }

  private nextStamp(): number {
    this.lastStamp = Math.max((this.deps.now ?? Date.now)(), this.lastStamp + 1)
    return this.lastStamp
  }

  stamped(kind: 'invite' | 'elevate'): SignedHeaders {
    const { keys, id } = this.who()
    const stamp = this.nextStamp()
    return {
      'X-Device-Timestamp': String(stamp),
      'X-Device-Signature': signStamped(keys, kind, id, stamp),
    }
  }

  revoke(targetId: string): SignedHeaders {
    const { keys, id } = this.who()
    return { 'X-Device-Signature': signRevoke(keys, id, targetId) }
  }

  approve(approvalId: string, requesterId: string): SignedHeaders {
    const { keys, id } = this.who()
    return { 'X-Device-Signature': signApprove(keys, id, approvalId, requesterId) }
  }

  seen(targetId: string): string {
    const { keys, id } = this.who()
    return signSeen(keys, id, targetId)
  }
}
