import type { ApprovalOutcome } from '../../shared/approvals'
import { normalizeOrigin } from '../../shared/credentials'

export interface FillGuest {
  url: () => string
  fill: (username: string, password: string) => Promise<boolean>
}

export interface LoginFillerDeps {
  guests: (workspaceId: string) => FillGuest[]
  logins: (origin: string) => { username: string; password: string }[]
  ask: (ask: {
    workspaceId: string
    paneId: string
    subject: string
    reason: string
  }) => Promise<ApprovalOutcome>
}

export type LoginFillResult =
  | { ok: true }
  | {
      ok: false
      error: 'invalid-origin' | 'origin-mismatch' | 'no-login' | 'denied' | 'no-form'
    }

export class LoginFiller {
  constructor(private readonly deps: LoginFillerDeps) {}

  async fill(
    workspaceId: string,
    paneId: string,
    origin: string,
    reason: string,
  ): Promise<LoginFillResult> {
    const wanted = normalizeOrigin(origin)
    if (!wanted) return { ok: false, error: 'invalid-origin' }
    const guest = this.deps.guests(workspaceId).find((g) => normalizeOrigin(g.url()) === wanted)
    if (!guest) return { ok: false, error: 'origin-mismatch' }
    const login = this.deps.logins(wanted)[0]
    if (!login) return { ok: false, error: 'no-login' }
    const outcome = await this.deps.ask({
      workspaceId,
      paneId,
      subject: `${login.username}@${wanted}`,
      reason,
    })
    if (outcome !== 'once' && outcome !== 'session') return { ok: false, error: 'denied' }
    if (normalizeOrigin(guest.url()) !== wanted) return { ok: false, error: 'origin-mismatch' }
    return (await guest.fill(login.username, login.password))
      ? { ok: true }
      : { ok: false, error: 'no-form' }
  }
}
