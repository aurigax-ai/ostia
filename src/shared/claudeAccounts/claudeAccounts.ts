import { resumeFromHookPayload } from '../agents/agentResume'

export const DEFAULT_ACCOUNT = 'default'

const ACCOUNT_ID = /^[0-9a-f]{16}$/

export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && ACCOUNT_ID.test(value)
}

export interface ClaudeAccountView {
  id: string
  email: string | null
}

export interface ClaudeAccountsState {
  accounts: ClaudeAccountView[]
  current: string
  adding: boolean
  duplicate: string | null
  damaged: boolean
  recoverable: number
}

export type AddAccountOutcome = 'opened' | 'busy' | 'not-opened' | 'no-workspace' | 'damaged'

export type RemoveAccountOutcome = 'removed' | 'unknown' | 'running' | 'damaged'

export const NO_ACCOUNTS: ClaudeAccountsState = {
  accounts: [{ id: DEFAULT_ACCOUNT, email: null }],
  current: DEFAULT_ACCOUNT,
  adding: false,
  duplicate: null,
  damaged: false,
  recoverable: 0,
}

export function sessionIdOfArgs(args: readonly string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--resume' || arg === '-r') return resumeFromHookPayload(args[i + 1] ?? '')
    if (arg.startsWith('--resume=')) return resumeFromHookPayload(arg.slice('--resume='.length))
  }
  return null
}

export function accountOfTarget(
  accounts: readonly ClaudeAccountView[],
  target: string,
): ClaudeAccountView | null {
  const wanted = target.trim().toLowerCase()
  if (/^[0-9]+$/.test(wanted)) return accounts[Number(wanted) - 1] ?? null
  return accounts.find((account) => account.email?.toLowerCase() === wanted) ?? null
}
