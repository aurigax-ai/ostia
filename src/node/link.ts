import { BUS_SEND_TEXT_MAX } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import {
  enqueue,
  failedOnRoute,
  getMail,
  type Mail,
  onMailQueued,
  peersOfRoute,
  postEvent,
  queuedOnRoute,
  receive,
  setPending,
  storedOnRoute,
} from '../main/agents/busStore'
import {
  LINK_DEAD_MS,
  LINK_HEARTBEAT_MS,
  type LinkFrame,
  parseFrame,
} from '../shared/remote/linkFrames'
import { backNotice, desktopRef, offlineNotice } from '../shared/remote/remoteRef'
import type { Jobs } from './jobs'

const DESKTOP_ROUTE = 'desktop'
const SYSTEM_SENDER = 'ostia'

interface Session {
  conn: MessageConnection
  lastRx: number
  heartbeat: ReturnType<typeof setInterval>
}

export class RunnerLink {
  private session: Session | null = null
  private ready = false
  private downSince: string | null = null
  private everUp = false
  private delivered = 0
  private resync = false
  private readonly noticed = new Set<string>()

  constructor(
    private readonly jobs: Jobs,
    private readonly version: string,
    private readonly now: () => number = Date.now,
  ) {
    onMailQueued((mail) => this.forward(mail))
  }

  isUp(): boolean {
    return this.ready
  }

  attach(conn: MessageConnection): void {
    this.drop()
    const session: Session = {
      conn,
      lastRx: this.now(),
      heartbeat: setInterval(() => this.tick(session), LINK_HEARTBEAT_MS),
    }
    session.heartbeat.unref?.()
    this.session = session
    conn.onNotification('link.in', (line: unknown) => {
      session.lastRx = this.now()
      const frame = typeof line === 'string' ? parseFrame(line) : null
      if (frame && this.session === session) void this.receive(frame)
    })
    conn.onClose(() => {
      if (this.session === session) this.drop()
    })
  }

  noteSend(pane: string, mail: Mail): void {
    if (this.ready) return
    setPending(mail.id, 'remote-offline')
    if (this.noticed.has(pane)) return
    this.noticed.add(pane)
    this.notify([pane], offlineNotice('desktop', this.downStamp(), this.waiting()))
  }

  private tick(session: Session): void {
    if (this.now() - session.lastRx >= LINK_DEAD_MS) {
      if (this.session === session) this.drop()
      return
    }
    this.send({ t: 'hb' })
    if (this.ready) this.flush()
  }

  private waiting(): number {
    return queuedOnRoute(DESKTOP_ROUTE).length
  }

  private downStamp(): string {
    return (this.downSince ?? new Date(this.now()).toISOString()).slice(11, 16)
  }

  private notify(peers: Iterable<string>, text: string): void {
    for (const peer of peers) if (this.jobs.get(peer)) postEvent(SYSTEM_SENDER, peer, text)
  }

  private send(frame: LinkFrame): void {
    if (!this.session) return
    void this.session.conn.sendNotification('link.out', JSON.stringify(frame)).catch(() => {})
  }

  private drop(): void {
    const session = this.session
    this.session = null
    if (session) {
      clearInterval(session.heartbeat)
      session.conn.dispose()
    }
    if (!this.ready) return
    this.ready = false
    this.downSince = new Date(this.now()).toISOString()
    this.noticed.clear()
    this.notify(
      peersOfRoute(DESKTOP_ROUTE),
      offlineNotice('desktop', this.downStamp(), this.waiting()),
    )
  }

  private forward(mail: Mail): void {
    if (mail.route === DESKTOP_ROUTE && this.ready) this.sendMail(mail)
  }

  private sendMail(mail: Mail): void {
    const sender = this.jobs.get(mail.from)
    if (!sender || !mail.text) return
    this.send({ t: 'mail', id: mail.id, from: sender.pane, to: mail.to, text: mail.text })
  }

  private flush(): void {
    for (const mail of queuedOnRoute(DESKTOP_ROUTE)) this.sendMail(mail)
    this.backIfDrained()
  }

  private backIfDrained(): void {
    if (!this.resync || this.waiting() > 0) return
    this.resync = false
    const expired = failedOnRoute(DESKTOP_ROUTE, this.downSince ?? '')
    this.notify(peersOfRoute(DESKTOP_ROUTE), backNotice('desktop', this.delivered, expired))
    this.delivered = 0
  }

  private async receive(frame: LinkFrame): Promise<void> {
    if (frame.t === 'hello') {
      if (frame.version !== this.version) {
        this.send({ t: 'incompatible', version: this.version })
        return
      }
      this.send({ t: 'hello-ok', version: this.version })
      this.ready = true
      this.resync = this.everUp
      this.everUp = true
      this.flush()
      return
    }
    if (!this.ready) return
    if (frame.t === 'stored') {
      const wasQueued = getMail(frame.id)?.state === 'queued'
      if (storedOnRoute(DESKTOP_ROUTE, frame.id) && wasQueued) this.delivered += 1
      this.backIfDrained()
      return
    }
    if (frame.t !== 'mail') return
    const target = this.jobs.resolve(frame.to)
    if (!target) return this.send({ t: 'refused', id: frame.id, reason: 'unknown-pane' })
    if (frame.text.length > BUS_SEND_TEXT_MAX) {
      return this.send({ t: 'refused', id: frame.id, reason: 'bad-text' })
    }
    const stored = await receive({
      id: `desktop:${frame.id}`,
      origin: DESKTOP_ROUTE,
      from: desktopRef(frame.from),
      to: target.pane,
      text: frame.text,
    }).catch(() => null)
    if (stored === null) return
    this.send(
      stored === 'stored'
        ? { t: 'stored', id: frame.id }
        : { t: 'refused', id: frame.id, reason: stored },
    )
  }
}

export function sendToDesktop(from: string, to: string, text: string): Mail {
  return enqueue({ from, to, text, route: DESKTOP_ROUTE })
}
