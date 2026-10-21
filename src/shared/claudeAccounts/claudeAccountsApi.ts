import type { AddAccountOutcome, ClaudeAccountsState } from './claudeAccounts'

interface ClaudeAccountsApi {
  state: () => Promise<ClaudeAccountsState>
  onChange: (cb: (state: ClaudeAccountsState) => void) => () => void
  add: () => Promise<AddAccountOutcome>
  remove: (id: string) => Promise<boolean>
  use: (id: string) => Promise<boolean>
}

export interface ClaudeAccountsBridge {
  claudeAccounts: ClaudeAccountsApi
}
