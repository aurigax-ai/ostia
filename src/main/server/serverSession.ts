import { type DeviceKeys, signChallenge } from './deviceKeys'
import { ServerError } from './serverClient'
import type { ServerRoutes } from './serverRoutes'

export const RENEW_MARGIN_MS = 60_000

export interface Session {
  token: string
  expiresAt: number
}

export interface SessionDeps {
  routes: Pick<ServerRoutes, 'challenge' | 'verify' | 'endSession'>
  keys: () => DeviceKeys | null
  deviceId: () => string | null
  now?: () => number
}

export class ServerSession {
  private session: Session | null = null
  private renewing: Promise<Session> | null = null

  constructor(private readonly deps: SessionDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  current(): Session | null {
    return this.session
  }

  private fresh(session: Session | null): session is Session {
    return session !== null && session.expiresAt - this.now() > RENEW_MARGIN_MS
  }

  private async open(): Promise<Session> {
    const keys = this.deps.keys()
    const deviceId = this.deps.deviceId()
    if (!keys || !deviceId) throw new ServerError(0, 'not-signed-in')
    const { nonce } = await this.deps.routes.challenge(deviceId)
    const grant = await this.deps.routes.verify(
      deviceId,
      nonce,
      signChallenge(keys, deviceId, nonce),
    )
    if (this.deps.deviceId() !== deviceId) throw new ServerError(0, 'not-signed-in')
    const session = { token: grant.token, expiresAt: grant.expiresAt }
    this.session = session
    return session
  }

  renew(stale?: string): Promise<Session> {
    if (stale !== undefined && this.session?.token !== stale && this.fresh(this.session)) {
      return Promise.resolve(this.session)
    }
    this.renewing ??= this.open().finally(() => {
      this.renewing = null
    })
    return this.renewing
  }

  async ensure(): Promise<Session> {
    if (this.fresh(this.session)) return this.session
    return this.renew()
  }

  async authed<T>(use: (token: string) => Promise<T>): Promise<T> {
    const first = await this.ensure()
    try {
      return await use(first.token)
    } catch (error) {
      if (!(error instanceof ServerError) || error.status !== 401) throw error
      const next = await this.renew(first.token)
      return use(next.token)
    }
  }

  async end(): Promise<void> {
    const session = this.session
    this.session = null
    if (!session) return
    try {
      await this.deps.routes.endSession(session.token)
    } catch {}
  }

  forget(): void {
    this.session = null
  }
}
