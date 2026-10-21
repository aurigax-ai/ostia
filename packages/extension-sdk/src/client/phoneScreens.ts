import type { MessageConnection } from 'vscode-jsonrpc/node'
import { isRecord } from '../contract/isRecord'
import {
  PHONE_SCREEN_EVENT_METHOD,
  PHONE_SCREEN_FRAME_METHOD,
  PHONE_SCREEN_OFFER_METHOD,
  PHONE_SCREENS_ASK_FOR_METHOD,
  PHONE_SCREENS_ASK_METHOD,
  PHONE_SCREENS_LISTEN_METHOD,
  PHONE_SCREENS_REQUEST_METHOD,
  type PhoneScreenAskFor,
  type PhoneScreenEvent,
  type PhoneScreenFrameHeader,
  type PhoneScreenFrameParams,
  type PhoneScreenLink,
  type PhoneScreenOfferReply,
  type PhoneScreenReply,
  type PhoneScreenRequest,
} from '../contract/phoneScreens'
import { errorMessage } from './results'

export interface PhoneScreenFrame {
  linkId: string
  header: PhoneScreenFrameHeader
  jpeg: Buffer
}

export interface PhoneScreensController {
  offer: (link: PhoneScreenLink) => boolean | Promise<boolean>
  frame?: (frame: PhoneScreenFrame) => void
  event?: (event: PhoneScreenEvent) => void
}

export interface PhoneScreens {
  listen: (controller: PhoneScreensController) => Promise<PhoneScreenReply>
  request: (
    linkId: string,
    method: PhoneScreenRequest,
    params?: Record<string, unknown>,
  ) => Promise<PhoneScreenReply>
  ask: (sessionId: string) => Promise<PhoneScreenReply>
  askFor: (request: PhoneScreenAskFor) => Promise<PhoneScreenReply>
}

async function called(work: Promise<unknown>): Promise<PhoneScreenReply> {
  try {
    const reply = await work
    if (isRecord(reply) && typeof reply.ok === 'boolean') return reply as PhoneScreenReply
    return { ok: false, error: 'failed' }
  } catch (err) {
    return { ok: false, error: 'failed', message: errorMessage(err) }
  }
}

export function phoneScreenMethods(conn: MessageConnection): PhoneScreens {
  let controller: PhoneScreensController | null = null
  let listening = false
  const startListening = (): void => {
    if (listening) return
    listening = true
    conn.onRequest(
      PHONE_SCREEN_OFFER_METHOD,
      async (link: PhoneScreenLink): Promise<PhoneScreenOfferReply> => {
        if (!controller) return { accept: false }
        try {
          return { accept: (await controller.offer(link)) === true }
        } catch {
          return { accept: false }
        }
      },
    )
    conn.onNotification(PHONE_SCREEN_FRAME_METHOD, (params: PhoneScreenFrameParams) => {
      controller?.frame?.({
        linkId: params.linkId,
        header: params.header,
        jpeg: Buffer.from(params.jpeg, 'base64'),
      })
    })
    conn.onNotification(PHONE_SCREEN_EVENT_METHOD, (event: PhoneScreenEvent) => {
      controller?.event?.(event)
    })
  }
  return {
    listen: (next) => {
      controller = next
      startListening()
      return called(conn.sendRequest(PHONE_SCREENS_LISTEN_METHOD, {}))
    },
    request: (linkId, method, params) =>
      called(conn.sendRequest(PHONE_SCREENS_REQUEST_METHOD, { linkId, method, params })),
    ask: (sessionId) => called(conn.sendRequest(PHONE_SCREENS_ASK_METHOD, { sessionId })),
    askFor: (request) => called(conn.sendRequest(PHONE_SCREENS_ASK_FOR_METHOD, request)),
  }
}
