import type { Registration } from './deviceKeys'
import type { ServerClient } from './serverClient'

export interface ServerInfo {
  api: number
  modules: { relay: boolean; publish: boolean; sync: boolean; push: boolean }
  auth: { invite: boolean; github: boolean }
  syncGCBound?: boolean
  deviceInactiveAfterSeconds?: number
  relayDomain: string
  limits?: { shareMaxBytes?: number; allowPublic?: boolean; allowNever?: boolean }
}

export interface ShareCreated {
  id: string
  url: string
  uploadUrl: string
  deleteToken: string
  expiresAt: number
}

export interface ShareRow {
  id: string
  url: string
  mode: 'link' | 'password' | 'public'
  size: number
  views: number
  createdAt: number
  expiresAt: number
  uploaded: boolean
  expired?: boolean
}

export interface CreateShareBody {
  mode: 'link' | 'password' | 'public'
  size: number
  expiresInSeconds: number
  salt?: string
}

export interface DeviceRegistered {
  accountId: string
  deviceId: string
  provider: 'invite' | 'github'
}

export interface GithubFlow {
  flowId: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

export type GithubPolled =
  | { status: 'pending'; interval: number }
  | ({ status: 'registered' } & DeviceRegistered)

export interface SessionGrant {
  token: string
  expiresAt: number
  accountId: string
}

export interface ManifestView {
  version: number
  blob: string
  updatedAt: number
}

export interface WrapSlot {
  slot: string
  updatedAt: number
}

export interface RotateBody {
  ifMatch: number
  manifest: string
  wraps: { passphrase: string; recovery: string }
}

export interface PushTicket {
  ticket: string
  expiresAt: number
}

export interface RelayLabel {
  label: string
  host: string
  port: number
}

export function serverRoutes(client: ServerClient) {
  return {
    info: () => client.request<ServerInfo>('GET', '/v1/info'),
    registerWithInvite: (code: string, name: string, registration: Registration) =>
      client.request<DeviceRegistered>('POST', '/v1/auth/invite', {
        body: { code, name, ...registration },
        reportsTime: true,
      }),
    githubDevice: () => client.request<GithubFlow>('POST', '/v1/auth/github/device'),
    githubPoll: async (
      flowId: string,
      name: string,
      registration: Registration,
    ): Promise<GithubPolled> => {
      const answer = await client.request<
        { status: 'pending'; interval: number } | DeviceRegistered
      >('POST', '/v1/auth/github/poll', {
        body: { flowId, name, ...registration },
        reportsTime: true,
      })
      return 'status' in answer ? answer : { status: 'registered', ...answer }
    },
    challenge: (deviceId: string) =>
      client.request<{ nonce: string }>('POST', '/v1/auth/challenge', { body: { deviceId } }),
    verify: (deviceId: string, nonce: string, sig: string) =>
      client.request<SessionGrant>('POST', '/v1/auth/verify', {
        body: { deviceId, nonce, sig },
        reportsTime: true,
      }),
    endSession: (token: string) => client.request<void>('DELETE', '/v1/auth/session', { token }),
    heartbeat: (token: string) =>
      client.request<void>('POST', '/v1/devices/heartbeat', { token, retryRateLimited: false }),
    revokeDevice: (token: string, id: string, headers: Record<string, string>) =>
      client.request<void>('DELETE', `/v1/devices/${encodeURIComponent(id)}`, {
        token,
        headers,
        retryRateLimited: false,
      }),
    manifest: (token: string) =>
      client.request<ManifestView>('GET', '/v1/sync/manifest', { token }),
    putManifest: (token: string, json: string, ifMatch: string, signed: Record<string, string>) =>
      client.request<{ version: number }>('PUT', '/v1/sync/manifest', {
        token,
        json,
        headers: { 'If-Match': ifMatch, ...signed },
        retryRateLimited: false,
      }),
    blob: (token: string, id: string) =>
      client.request<Buffer>('GET', `/v1/sync/blobs/${id}`, { token, asBytes: true }),
    putBlob: (token: string, id: string, bytes: Uint8Array<ArrayBuffer>) =>
      client.request<void>('PUT', `/v1/sync/blobs/${id}`, { token, bytes }),
    wraps: (token: string) =>
      client.request<{ wraps: WrapSlot[] }>('GET', '/v1/sync/wraps', { token }),
    secretWrap: (token: string, slot: 'passphrase' | 'recovery', headers: Record<string, string>) =>
      client.request<{ slot: string; blob: string }>('GET', `/v1/sync/wraps/${slot}`, {
        token,
        headers,
        retryRateLimited: false,
      }),
    putWrap: (token: string, slot: string, blob: string) =>
      client.request<void>('PUT', `/v1/sync/wraps/${slot}`, { token, body: { blob } }),
    rotate: (token: string, body: RotateBody) =>
      client.request<{ version: number }>('POST', '/v1/sync/rotate', { token, body }),
    gc: (token: string, json: string, ifMatch: string, signed: Record<string, string>) =>
      client.request<{ deleted: number }>('POST', '/v1/sync/gc', {
        token,
        json,
        headers: { 'If-Match': ifMatch, ...signed },
        retryRateLimited: false,
      }),
    createShare: (token: string, body: CreateShareBody) =>
      client.request<ShareCreated>('POST', '/v1/shares', { token, body }),
    uploadShare: (token: string, path: string, bytes: Uint8Array<ArrayBuffer>) =>
      client.request<void>('PUT', path, { token, bytes }),
    shares: (token: string) =>
      client.request<{ shares: ShareRow[] }>('GET', '/v1/shares', { token }),
    deleteShare: (id: string, auth: { token: string } | { deleteToken: string }) =>
      client.request<void>('DELETE', `/v1/shares/${encodeURIComponent(id)}`, {
        ...('token' in auth
          ? { token: auth.token }
          : { headers: { 'X-Delete-Token': auth.deleteToken } }),
      }),
    pushTicket: (token: string) =>
      client.request<PushTicket>('POST', '/v1/push/tickets', { token }),
    pushPing: (token: string, handle: string) =>
      client.request<void>('POST', `/v1/push/${encodeURIComponent(handle)}`, {
        token,
        retryRateLimited: false,
      }),
    pushDelete: (token: string, handle: string) =>
      client.request<void>('DELETE', `/v1/push/${encodeURIComponent(handle)}`, { token }),
    relayLabel: (token: string) => client.request<RelayLabel>('POST', '/v1/relay/label', { token }),
  }
}

export type ServerRoutes = ReturnType<typeof serverRoutes>
