import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import {
  PHONE_SCREEN_EVENT_METHOD,
  PHONE_SCREEN_FRAME_METHOD,
  PHONE_SCREEN_OFFER_METHOD,
  type PhoneScreenFrameParams,
  type PhoneScreenReply,
} from '@aurigax-ai/ostia-extension-sdk/contract/phoneScreens'
import type { MessageConnection } from 'vscode-jsonrpc/node'
import { hasCap } from '../approvals/capabilityStore'
import type { PaneIdentity } from '../control/idRegistry'
import type { ScreenLinkController, ScreenLinks } from '../gateway/screenLinks'
import type { Runtime } from './extensionRuntime'

export type PhoneScreenLinks = Pick<
  ScreenLinks,
  'listen' | 'release' | 'request' | 'ask' | 'askFor'
>

export interface ExtensionPhoneScreensHost {
  links: PhoneScreenLinks | undefined
  runtimeOf(identity: PaneIdentity, conn: MessageConnection): Runtime
  active(rt: Runtime): boolean
}

interface Holder {
  rt: Runtime
  conn: MessageConnection
  controller: ScreenLinkController
}

function controllerOn(conn: MessageConnection): ScreenLinkController {
  return {
    offer: async (link) => {
      const reply = await conn.sendRequest(PHONE_SCREEN_OFFER_METHOD, link)
      return isRecord(reply) && reply.accept === true
    },
    frame: (linkId, header, jpeg) => {
      const params: PhoneScreenFrameParams = { linkId, header, jpeg: jpeg.toString('base64') }
      void conn.sendNotification(PHONE_SCREEN_FRAME_METHOD, params).catch(() => {})
    },
    event: (event) => {
      void conn.sendNotification(PHONE_SCREEN_EVENT_METHOD, event).catch(() => {})
    },
  }
}

export class ExtensionPhoneScreens {
  private holder: Holder | null = null

  constructor(private readonly host: ExtensionPhoneScreensHost) {}

  listen(identity: PaneIdentity, conn: MessageConnection): PhoneScreenReply {
    const links = this.host.links
    if (!links) return { ok: false, error: 'unavailable' }
    const rt = this.host.runtimeOf(identity, conn)
    if (this.holder?.conn === conn) return { ok: true, data: null }
    if (this.holder) return { ok: false, error: 'busy' }
    const controller = controllerOn(conn)
    if (!links.listen(controller)) return { ok: false, error: 'busy' }
    this.holder = { rt, conn, controller }
    conn.onClose(() => this.drop(conn))
    conn.onDispose(() => this.drop(conn))
    return { ok: true, data: null }
  }

  request(
    identity: PaneIdentity,
    conn: MessageConnection,
    raw: unknown,
  ): Promise<PhoneScreenReply> {
    const holder = this.holderOf(identity, conn)
    if (!holder || !this.host.links) return Promise.resolve({ ok: false, error: 'not-listening' })
    const params = isRecord(raw) ? raw : {}
    if (typeof params.linkId !== 'string' || typeof params.method !== 'string') {
      return Promise.resolve({ ok: false, error: 'invalid-params' })
    }
    return this.host.links.request(holder.controller, params.linkId, params.method, params.params)
  }

  ask(identity: PaneIdentity, conn: MessageConnection, raw: unknown): Promise<PhoneScreenReply> {
    const holder = this.holderOf(identity, conn)
    if (!holder || !this.host.links) return Promise.resolve({ ok: false, error: 'not-listening' })
    const sessionId = isRecord(raw) ? raw.sessionId : undefined
    if (typeof sessionId !== 'string' || !sessionId) {
      return Promise.resolve({ ok: false, error: 'invalid-params' })
    }
    return this.host.links.ask(holder.controller, sessionId)
  }

  askFor(identity: PaneIdentity, conn: MessageConnection, raw: unknown): Promise<PhoneScreenReply> {
    const holder = this.holderOf(identity, conn)
    if (!holder || !this.host.links) return Promise.resolve({ ok: false, error: 'not-listening' })
    return this.host.links.askFor(holder.controller, raw)
  }

  recheck(): void {
    const holder = this.holder
    if (!holder) return
    const { rt } = holder
    const holds = rt.identity !== null && hasCap(rt.identity.externalId, 'phone-screens')
    if (rt.conn !== holder.conn || !holds || !this.host.active(rt)) this.drop(holder.conn)
  }

  private holderOf(identity: PaneIdentity, conn: MessageConnection): Holder | null {
    this.host.runtimeOf(identity, conn)
    return this.holder?.conn === conn ? this.holder : null
  }

  private drop(conn: MessageConnection): void {
    const holder = this.holder
    if (holder?.conn !== conn) return
    this.holder = null
    this.host.links?.release(holder.controller)
  }
}
