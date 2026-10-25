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

export type ServerSignOutResult =
  | { ok: true; deviceKept: boolean }
  | { ok: false; error: ServerFailure }

export type ServerActionResult = { ok: true } | { ok: false; error: ServerFailure }

export type ServerInfoResult =
  | { ok: true; offer: ServerOffer }
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
  signOut: () => Promise<ServerSignOutResult>
  onChanged: (cb: (status: ServerStatus) => void) => () => void
}

export interface ServerBridge {
  server: ServerApi
}
