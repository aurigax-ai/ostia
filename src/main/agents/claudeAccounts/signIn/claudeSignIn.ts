import type {
  BeginSignInOutcome,
  SignInStatus,
  SubmitCodeOutcome,
} from '../../../../shared/claudeAccounts/claudeAccounts'
import type { CallbackListener } from '../../../chat/mcpOAuth'
import {
  authorizeUrl,
  type OAuthProfile,
  type OAuthTokens,
  type Pkce,
  validCode,
} from './anthropicOAuth'

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000

export type CompleteOutcome = 'done' | 'mismatch' | 'failed'

export interface SignInDeps {
  listen: (opts: { state: string; timeoutMs: number }) => Promise<CallbackListener>
  openExternal: (url: string) => boolean
  createPkce: () => Pkce
  exchange: (code: string, redirectUri: string, pkce: Pkce) => Promise<OAuthTokens | null>
  profile: (accessToken: string) => Promise<OAuthProfile | null>
  complete: (
    target: string | null,
    tokens: OAuthTokens,
    profile: OAuthProfile,
  ) => Promise<CompleteOutcome>
  onChange: () => void
  timeoutMs?: number
}

interface Attempt {
  target: string | null
  pkce: Pkce
  listener: CallbackListener
}

export class ClaudeSignIn {
  private attempt: Attempt | null = null
  private current: SignInStatus = 'idle'

  constructor(private readonly deps: SignInDeps) {}

  get status(): SignInStatus {
    return this.current
  }

  get busy(): boolean {
    return this.current === 'waiting' || this.current === 'working'
  }

  async begin(target: string | null): Promise<BeginSignInOutcome> {
    if (this.busy) return 'busy'
    this.discard()
    const pkce = this.deps.createPkce()
    this.current = 'waiting'
    let listener: CallbackListener
    try {
      listener = await this.deps.listen({
        state: pkce.state,
        timeoutMs: this.deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
      })
    } catch {
      this.current = 'failed'
      this.deps.onChange()
      return 'started'
    }
    const attempt: Attempt = { target, pkce, listener }
    this.attempt = attempt
    listener.result.then(
      ({ code }) => void this.finish(attempt, code),
      () => this.lapse(attempt),
    )
    this.deps.onChange()
    return 'started'
  }

  open(): boolean {
    const { attempt } = this
    return (
      this.current === 'waiting' &&
      attempt !== null &&
      this.deps.openExternal(authorizeUrl(attempt.listener.redirectUrl, attempt.pkce))
    )
  }

  submit(input: string): SubmitCodeOutcome {
    const { attempt } = this
    if (this.current !== 'waiting' || !attempt) return 'idle'
    const code = validCode(input)
    if (!code) return 'invalid'
    void this.finish(attempt, code)
    return 'accepted'
  }

  cancel(): void {
    if (this.current === 'working') return
    this.discard()
    this.current = 'idle'
    this.deps.onChange()
  }

  private discard(): void {
    this.attempt?.listener.close()
    this.attempt = null
  }

  private lapse(attempt: Attempt): void {
    if (this.attempt !== attempt || this.current !== 'waiting') return
    this.attempt = null
    this.current = 'failed'
    this.deps.onChange()
  }

  private async finish(attempt: Attempt, code: string): Promise<void> {
    if (this.attempt !== attempt || this.current !== 'waiting') return
    this.current = 'working'
    attempt.listener.close()
    this.deps.onChange()
    let outcome: CompleteOutcome = 'failed'
    try {
      const tokens = await this.deps.exchange(code, attempt.listener.redirectUrl, attempt.pkce)
      const profile = tokens ? await this.deps.profile(tokens.accessToken) : null
      if (tokens && profile) outcome = await this.deps.complete(attempt.target, tokens, profile)
    } catch {
      outcome = 'failed'
    }
    if (this.attempt !== attempt) return
    this.attempt = null
    this.current = outcome === 'done' ? 'idle' : outcome
    this.deps.onChange()
  }
}
