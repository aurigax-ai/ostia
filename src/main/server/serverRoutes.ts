import type { Registration } from './deviceKeys'
import type { ServerClient } from './serverClient'

export interface ServerInfo {
  api: number
  modules: { relay: boolean; publish: boolean; sync: boolean; push: boolean }
  auth: { invite: boolean; github: boolean }
  relayDomain: string
  shareDomain: string
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

export interface DeviceRow {
  id: string
  name: string
  lastSeen: number
  current?: boolean
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
      }),
    githubDevice: () => client.request<GithubFlow>('POST', '/v1/auth/github/device'),
    githubPoll: async (
      flowId: string,
      name: string,
      registration: Registration,
    ): Promise<GithubPolled> => {
      const answer = await client.request<
        { status: 'pending'; interval: number } | DeviceRegistered
      >('POST', '/v1/auth/github/poll', { body: { flowId, name, ...registration } })
      return 'status' in answer ? answer : { status: 'registered', ...answer }
    },
    challenge: (deviceId: string) =>
      client.request<{ nonce: string }>('POST', '/v1/auth/challenge', { body: { deviceId } }),
    verify: (deviceId: string, nonce: string, sig: string) =>
      client.request<SessionGrant>('POST', '/v1/auth/verify', { body: { deviceId, nonce, sig } }),
    endSession: (token: string) => client.request<void>('DELETE', '/v1/auth/session', { token }),
    devices: (token: string) =>
      client.request<{ devices: DeviceRow[] }>('GET', '/v1/devices', { token }),
    relayLabel: (token: string) =>
      client.request<RelayLabel>('POST', '/v1/relay/label', { token }),
  }
}

export type ServerRoutes = ReturnType<typeof serverRoutes>
