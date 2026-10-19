export const PHONE_SCREENS_LISTEN_METHOD = 'ext.phoneScreens.listen'
export const PHONE_SCREENS_REQUEST_METHOD = 'ext.phoneScreens.request'
export const PHONE_SCREENS_ASK_METHOD = 'ext.phoneScreens.ask'
export const PHONE_SCREEN_OFFER_METHOD = 'ext.phoneScreen.offer'
export const PHONE_SCREEN_FRAME_METHOD = 'ext.phoneScreen.frame'
export const PHONE_SCREEN_EVENT_METHOD = 'ext.phoneScreen.event'

export const PHONE_SCREEN_REQUESTS = [
  'phone.capture',
  'phone.stream',
  'phone.tap',
  'phone.swipe',
  'phone.type',
  'phone.key',
  'phone.launch',
  'phone.apps',
  'phone.tree',
  'phone.stop',
] as const

export type PhoneScreenRequest = (typeof PHONE_SCREEN_REQUESTS)[number]

export const PHONE_SCREEN_INPUT_REQUESTS: readonly PhoneScreenRequest[] = [
  'phone.tap',
  'phone.swipe',
  'phone.type',
  'phone.key',
  'phone.launch',
]

export const PHONE_SCREEN_LIMITS_SEC = [300, 900, 1800] as const
export const PHONE_SCREEN_ROTATIONS = [0, 90, 180, 270] as const
export const PHONE_SCREEN_FPS_MAX = 5
export const PHONE_SCREEN_REQUEST_MS = 75_000

export type PhoneScreenLevel = 'view' | 'control'

export interface PhoneScreenLink {
  linkId: string
  sessionId: string
  width: number
  height: number
  density: number
  rotation: (typeof PHONE_SCREEN_ROTATIONS)[number]
  level: PhoneScreenLevel
  limitSec: (typeof PHONE_SCREEN_LIMITS_SEC)[number]
  endsAt: number
  overlayHeight: number
  label: string
  agent?: 'claude' | 'codex'
  device: { id: string; name: string }
}

export interface PhoneScreenFrameHeader {
  seq: number
  width: number
  height: number
  screenWidth: number
  screenHeight: number
  blocked: boolean
}

export interface PhoneScreenFrameParams {
  linkId: string
  header: PhoneScreenFrameHeader
  jpeg: string
}

export type PhoneScreenEndReason =
  | 'closed'
  | 'revoked'
  | 'caps-changed'
  | 'time-limit'
  | 'no-controller'

export type PhoneScreenEvent =
  | { linkId: string; kind: 'state'; payload: unknown }
  | { linkId: string; kind: 'foreground'; payload: unknown }
  | { linkId: string; kind: 'ended'; payload: { reason: PhoneScreenEndReason } }

export interface PhoneScreenRequestParams {
  linkId: string
  method: PhoneScreenRequest
  params?: Record<string, unknown>
}

export type PhoneScreenReply =
  | { ok: true; data: unknown }
  | { ok: false; error: string; message?: string; data?: unknown }

export interface PhoneScreenOfferReply {
  accept: boolean
}
