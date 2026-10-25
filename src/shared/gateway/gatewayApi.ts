import type { PhoneGrantableCap } from './phoneCapabilities'

export type GatewayTailnetState =
  | { state: 'off' }
  | { state: 'starting' }
  | { state: 'needs-login'; authUrl: string }
  | { state: 'running'; ip: string | null; dnsName: string | null }
  | { state: 'error'; code: string }

interface GatewayStatus {
  running: boolean
  host: string | null
  port: number | null
  fingerprint: string | null
  deviceCount: number
}

export interface GatewayPhoneAddress {
  host: string
  port: number
}

export interface GatewayRoute {
  bindAddress: string
  bindInterface: string | null
  tailnet: boolean
  phoneAddress: GatewayPhoneAddress | null
  relay: boolean
}

export type GatewayRelayState =
  | { state: 'off' | 'needs-sign-in' | 'connecting' }
  | { state: 'listening'; host: string; port: number }
  | { state: 'error'; code: string }

export interface GatewayBindAddress {
  address: string
  iface: string
  loopback: boolean
}

export type GatewayPushAvailability =
  | 'available'
  | 'not-signed-in'
  | 'server-push-off'
  | 'unreachable'

export interface GatewayRemoteStatus extends GatewayStatus {
  tailnet: GatewayTailnetState
  route: GatewayRoute
  relay: GatewayRelayState
  discoverable: boolean
  push: GatewayPushAvailability
}

export interface GatewayPairRequest {
  requestId: string
  name: string
  checkCode: string
  replaces: { name: string; lastSeenAt: string | null; caps: string[] } | null
}

export type GatewayActionResult = { ok: true } | { ok: false; error: 'not-a-window' | 'invalid' }

export type GatewayEnableResponse = GatewayRemoteStatus | { error: 'address-unavailable' }

export type GatewaySetRouteResult =
  | { ok: true; route: GatewayRoute }
  | {
      ok: false
      error:
        | 'not-a-window'
        | 'running'
        | 'unknown-address'
        | 'invalid-phone-address'
        | 'two-methods'
    }

export interface GatewayPairResult {
  v: 1
  host: string
  port: number
  fingerprint: string
  pairCode: string
  name: string
}

export type GatewayPairResponse = GatewayPairResult | { error: 'not-running' }

export type GatewayTailnetActionResult =
  | { ok: true }
  | { ok: false; error: 'not-a-window' | 'no-login-link' | 'login-link-refused' }

export interface GatewayDevice {
  deviceId: string
  name: string
  pubkey: string
  caps: string[]
  createdAt: string
  push: { enabled: boolean; registered: boolean }
}

export type GatewaySetPushResult =
  | { ok: true }
  | {
      ok: false
      error:
        | 'not-a-window'
        | 'invalid'
        | 'not-found'
        | 'needs-notify'
        | Exclude<GatewayPushAvailability, 'available'>
    }

export type GatewaySetCapResult =
  | { ok: true; caps: string[] }
  | { ok: false; error: 'not-found' | 'invalid-cap' | 'requires-command' }

export type PhoneAgentName = 'claude' | 'codex'

export interface GatewayPhoneWorkspaceSave {
  folder: string | null
  agent: PhoneAgentName
}

export interface GatewayPhoneWorkspace extends Omit<GatewayPhoneWorkspaceSave, 'folder'> {
  folder: string
  isDefault: boolean
  absent: boolean
  problem?: string
}

export type GatewayPhoneWorkspaceResult =
  | { ok: true; value: GatewayPhoneWorkspace }
  | { ok: false; error: string }

interface GatewayApi {
  enable: () => Promise<GatewayEnableResponse>
  disable: () => Promise<GatewayRemoteStatus>
  pair: () => Promise<GatewayPairResponse>
  status: () => Promise<GatewayRemoteStatus>
  devices: () => Promise<{ devices: GatewayDevice[] }>
  revoke: (deviceId: string) => Promise<{ ok: boolean; error?: string }>
  setCap: (
    deviceId: string,
    cap: PhoneGrantableCap,
    granted: boolean,
  ) => Promise<GatewaySetCapResult>
  setDevicePush: (deviceId: string, enabled: boolean) => Promise<GatewaySetPushResult>
  onPushChanged: (cb: () => void) => () => void
  bindAddresses: () => Promise<GatewayBindAddress[]>
  setRoute: (route: GatewayRoute) => Promise<GatewaySetRouteResult>
  tailnetSignIn: () => Promise<GatewayTailnetActionResult>
  tailnetSignOut: () => Promise<GatewayTailnetActionResult>
  onTailnetChanged: (cb: (state: GatewayTailnetState) => void) => () => void
  onRelayChanged: (cb: (state: GatewayRelayState) => void) => () => void
  setDiscoverable: (on: boolean) => Promise<GatewayActionResult>
  pairRequests: () => Promise<GatewayPairRequest[]>
  answerPairRequest: (requestId: string, approve: boolean) => Promise<GatewayActionResult>
  onPairRequestsChanged: (cb: (requests: GatewayPairRequest[]) => void) => () => void
  phoneWorkspace: () => Promise<GatewayPhoneWorkspace>
  setPhoneWorkspace: (save: GatewayPhoneWorkspaceSave) => Promise<GatewayPhoneWorkspaceResult>
}

export interface GatewayBridge {
  gateway: GatewayApi
}
