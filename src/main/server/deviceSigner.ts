import { type DeviceKeys, type StampedKind, signApprove, signStamped } from './deviceKeys'
import { ServerError } from './serverClient'

export interface SignerDeps {
  keys: () => DeviceKeys | null
  deviceId: () => string | null
  now?: () => number
}

export type SignedHeaders = Record<string, string>

const SKEW_WINDOW_MS = 2 * 60 * 1000
const OFFSET_LIMIT_MS = 10 * 60 * 1000
const REFUSALS = new Set(['stale-signature', 'bad-signature', 'device-signature-required'])

const refused = (error: unknown): error is ServerError =>
  error instanceof ServerError && error.status === 403 && REFUSALS.has(error.code)

export class DeviceSigner {
  private accepted = 0
  private sent = 0
  private offset = 0
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: SignerDeps) {}

  private clock(): number {
    return (this.deps.now ?? Date.now)()
  }

  private who(): { keys: DeviceKeys; id: string } {
    const keys = this.deps.keys()
    const id = this.deps.deviceId()
    if (!keys || !id) throw new ServerError(0, 'not-signed-in')
    return { keys, id }
  }

  observeServerTime(serverMs: number): void {
    this.offset = Math.max(-OFFSET_LIMIT_MS, Math.min(OFFSET_LIMIT_MS, serverMs - this.clock()))
  }

  private async attempt<T>(
    kind: StampedKind,
    send: (headers: SignedHeaders) => Promise<T>,
    bound: readonly string[],
    floor = 0,
  ): Promise<T> {
    const { keys, id } = this.who()
    const stamp = Math.max(this.clock() + this.offset, this.accepted + 1, floor)
    this.sent = stamp
    const headers = {
      'X-Device-Timestamp': String(stamp),
      'X-Device-Signature': signStamped(keys, kind, id, stamp, bound),
    }
    try {
      const result = await send(headers)
      this.accepted = stamp
      return result
    } catch (error) {
      if (!refused(error)) this.accepted = Math.max(this.accepted, stamp)
      throw error
    }
  }

  signed<T>(
    kind: StampedKind,
    send: (headers: SignedHeaders) => Promise<T>,
    bound: readonly string[] = [],
  ): Promise<T> {
    const run = async (): Promise<T> => {
      try {
        return await this.attempt(kind, send, bound)
      } catch (error) {
        if (!refused(error) || error.code !== 'stale-signature') throw error
        const refusedAt = this.sent
        if (error.serverTime !== null) this.observeServerTime(error.serverTime)
        const behind =
          error.serverTime === null || Math.abs(refusedAt - error.serverTime) <= SKEW_WINDOW_MS
        return this.attempt(kind, send, bound, behind ? refusedAt + 1 : 0)
      }
    }
    const result = this.tail.then(run, run)
    this.tail = result.catch(() => undefined)
    return result
  }

  approve(approvalId: string, requesterId: string): SignedHeaders {
    const { keys, id } = this.who()
    return { 'X-Device-Signature': signApprove(keys, id, approvalId, requesterId) }
  }
}
