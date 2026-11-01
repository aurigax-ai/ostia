export const DEFAULT_ACCOUNT = 'default'

const ACCOUNT_ID = /^[0-9a-f]{16}$/

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value)
}

export interface UsageWindow {
  percent: number
  resetsAt: number
}

export interface AccountUsage {
  session: UsageWindow | null
  weekly: UsageWindow | null
  checkedAt: number
}

export function percentNow(window: UsageWindow | null, now: number): number | null {
  if (!window) return null
  return window.resetsAt <= now ? 0 : Math.round(window.percent)
}

export interface ClaudeAccountView {
  id: string
  email: string | null
  signedOut: boolean
  enabled: boolean
  sameAs: string | null
  usage: AccountUsage | null
}

export type SignInStatus = 'idle' | 'waiting' | 'working' | 'failed' | 'mismatch'

export interface ClaudeAccountsState {
  accounts: ClaudeAccountView[]
  current: string
  adding: boolean
  signInAvailable: boolean
  signIn: SignInStatus
  duplicate: string | null
  damaged: boolean
  recoverable: number
  checkUsage: boolean
  usageAvailable: boolean
}

export type AddAccountOutcome = 'opened' | 'busy' | 'not-opened' | 'no-workspace' | 'damaged'

export type BeginSignInOutcome = 'started' | 'busy' | 'unknown' | 'damaged' | 'unavailable'

export type SubmitCodeOutcome = 'accepted' | 'invalid' | 'idle'

export type SetEnabledOutcome = 'done' | 'unknown' | 'default' | 'current' | 'damaged'

export type RemoveAccountOutcome = 'removed' | 'unknown' | 'running' | 'damaged'

export const NO_ACCOUNTS: ClaudeAccountsState = {
  accounts: [
    {
      id: DEFAULT_ACCOUNT,
      email: null,
      signedOut: false,
      enabled: true,
      sameAs: null,
      usage: null,
    },
  ],
  current: DEFAULT_ACCOUNT,
  adding: false,
  signInAvailable: false,
  signIn: 'idle',
  duplicate: null,
  damaged: false,
  recoverable: 0,
  checkUsage: false,
  usageAvailable: false,
}

export function accountOfTarget(
  accounts: readonly ClaudeAccountView[],
  target: string,
): ClaudeAccountView | null {
  const wanted = target.trim().toLowerCase()
  if (/^[0-9]+$/.test(wanted)) return accounts[Number(wanted) - 1] ?? null
  return accounts.find((account) => account.email?.toLowerCase() === wanted) ?? null
}
