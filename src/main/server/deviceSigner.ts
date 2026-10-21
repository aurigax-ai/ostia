import {
  type DeviceKeys,
  type StampedKind,
  signApprove,
  signRevoke,
  signSeen,
  signStamped,
} from './deviceKeys'
import { ServerError } from './serverClient'

export interface SignerDeps {
  keys: () => DeviceKeys | null
  deviceId: () => string | null
  now?: () => number
}

export type SignedHeaders = Record<string, string>

export class DeviceSigner {
  private lastStamp = 0
  private offset = 0
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: SignerDeps) {}

  private who(): { keys: DeviceKeys; id: string } {
    const keys = this.deps.keys()
    const id = this.deps.deviceId()
    if (!keys || !id) throw new ServerError(0, 'not-signed-in')
    return { keys, id }
  }

  private nextStamp(): number {
    this.lastStamp = Math.max((this.deps.now ?? Date.now)() + this.offset, this.lastStamp + 1)
    return this.lastStamp
  }

  observeServerTime(serverMs: number): void {
    this.offset = serverMs - (this.deps.now ?? Date.now)()
  }

  signed<T>(
    kind: StampedKind,
    send: (headers: SignedHeaders) => Promise<T>,
    bound: readonly string[] = [],
  ): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await send(this.stamped(kind, bound))
      } catch (error) {
        if (!(error instanceof ServerError) || error.code !== 'stale-signature') throw error
        return send(this.stamped(kind, bound))
      }
    }
    const result = this.tail.then(run, run)
    this.tail = result.catch(() => undefined)
    return result
  }

  private stamped(kind: StampedKind, bound: readonly string[]): SignedHeaders {
    const { keys, id } = this.who()
    const stamp = this.nextStamp()
    return {
      'X-Device-Timestamp': String(stamp),
      'X-Device-Signature': signStamped(keys, kind, id, stamp, bound),
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
