import { PtyRingBuffer } from './ptyRingBuffer'

export type SubscriberRole = 'owner' | 'observer'
export interface Subscriber {
  id: string
  role: SubscriberRole
  send: (data: string, cursor: number) => void
}

/**
 * One pty's fan-out: a ring buffer plus a set of subscribers (owners = read/write and hold
 * the pty open; observers = read-only, e.g. the phone). Pure — the IPC layer injects the
 * WebContents `send` and wires onNoOwners → detach-grace kill. See ptyRingBuffer for trim.
 */
export class PtySession {
  private readonly ring: PtyRingBuffer
  private readonly subs = new Map<string, Subscriber>()
  private readonly onNoOwners?: () => void
  private readonly onExitCb?: (code: number) => void

  constructor(opts?: {
    capBytes?: number
    onNoOwners?: () => void
    onExit?: (code: number) => void
  }) {
    this.ring = new PtyRingBuffer(opts?.capBytes)
    this.onNoOwners = opts?.onNoOwners
    this.onExitCb = opts?.onExit
  }

  push(data: string): void {
    this.ring.push(data)
    const cursor = this.ring.end
    for (const s of this.subs.values()) s.send(data, cursor)
  }

  exit(code: number): void {
    this.onExitCb?.(code)
  }

  addSubscriber(sub: Subscriber, sinceCursor = 0): { cursor: number; dropped: boolean } {
    this.subs.set(sub.id, sub)
    const { data, cursor, dropped } = this.ring.since(sinceCursor)
    if (data) sub.send(data, cursor)
    return { cursor, dropped }
  }

  /** Read-only replay of buffered output since `cursor` (NO send). Used for attach's return value. */
  since(sinceCursor = 0): { data: string; cursor: number; dropped: boolean } {
    return this.ring.since(sinceCursor)
  }

  /** Register a subscriber for FUTURE live output only (no replay). Caller replays via since(). */
  addLiveSubscriber(sub: Subscriber): void {
    this.subs.set(sub.id, sub)
  }

  removeSubscriber(id: string): void {
    const sub = this.subs.get(id)
    if (!sub) return
    this.subs.delete(id)
    if (sub.role === 'owner' && this.ownerCount === 0) this.onNoOwners?.()
  }

  get ownerCount(): number {
    let n = 0
    for (const s of this.subs.values()) if (s.role === 'owner') n++
    return n
  }

  canWrite(id: string): boolean {
    return this.subs.get(id)?.role === 'owner'
  }
}
