export type ServerProvider = 'invite' | 'github'

export type ServerFailure =
  | 'not-a-window'
  | 'no-server'
  | 'invalid-url'
  | 'not-signed-in'
  | 'already-signed-in'
  | 'unreachable'
  | 'rate-limited'
  | 'invalid-invite'
  | 'device-limit'
  | 'unavailable'
  | 'elevation-required'
  | 'device-too-new'
  | 'requester-too-new'
  | 'no-second-device'
  | 'not-a-github-account'
  | 'stale-signature'
  | 'expired'
  | 'quota'
  | 'failed'

export interface ServerStatus {
  url: string | null
  host: string | null
  signedIn: boolean
  provider: ServerProvider | null
  deviceName: string | null
}

export interface ServerOffer {
  relay: boolean
  publish: boolean
  sync: boolean
  push: boolean
  invite: boolean
  github: boolean
}

export interface ServerDevice {
  id: string
  name: string
  current: boolean
  lastSeen: number
  createdAt: number
  isNew: boolean
}

interface ServerApproval {
  id: string
  deviceName: string
  deviceCreatedAt: number
  createdAt: number
  expiresAt: number
}

export type ElevationMethod = 'approval' | 'github'

export type ElevationStartResult =
  | { ok: true; kind: 'approval' }
  | { ok: true; kind: 'github'; userCode: string; verificationUri: string }
  | { ok: false; error: ServerFailure }

export type ElevationPollResult =
  | { state: 'pending' }
  | { state: 'done' }
  | { state: 'error'; error: ServerFailure }

export type ServerInviteResult =
  | { ok: true; code: string; expiresAt: number }
  | { ok: false; error: ServerFailure }

export type ServerApprovalsResult =
  | { ok: true; approvals: ServerApproval[] }
  | { ok: false; error: ServerFailure }

export type ServerActionResult = { ok: true } | { ok: false; error: ServerFailure }

export type ServerInfoResult =
  | { ok: true; offer: ServerOffer }
  | { ok: false; error: ServerFailure }

export type ServerDevicesResult =
  | { ok: true; devices: ServerDevice[] }
  | { ok: false; error: ServerFailure }

export type GithubStartResult =
  | { ok: true; userCode: string; verificationUri: string }
  | { ok: false; error: ServerFailure }

export type GithubPollResult =
  | { state: 'pending' }
  | { state: 'done' }
  | { state: 'error'; error: ServerFailure | 'denied' | 'expired' }

interface ServerApi {
  status: () => Promise<ServerStatus>
  setUrl: (url: string) => Promise<ServerActionResult>
  info: () => Promise<ServerInfoResult>
  signInWithInvite: (code: string) => Promise<ServerActionResult>
  githubStart: () => Promise<GithubStartResult>
  githubPoll: () => Promise<GithubPollResult>
  githubCancel: () => Promise<void>
  openVerification: () => Promise<void>
  signOut: () => Promise<ServerActionResult>
  devices: () => Promise<ServerDevicesResult>
  markSeen: (deviceId: string) => Promise<ServerActionResult>
  createInvite: () => Promise<ServerInviteResult>
  elevationStart: (method: ElevationMethod) => Promise<ElevationStartResult>
  elevationPoll: () => Promise<ElevationPollResult>
  elevationCancel: () => Promise<void>
  approvals: () => Promise<ServerApprovalsResult>
  approve: (approvalId: string) => Promise<ServerActionResult>
  onChanged: (cb: (status: ServerStatus) => void) => () => void
  onDevicesChanged: (cb: () => void) => () => void
}

export interface ServerBridge {
  server: ServerApi
}
