import type { AddAccountOutcome, ClaudeAccountsState, RemoveAccountOutcome } from './claudeAccounts'

interface ClaudeAccountsApi {
  state: () => Promise<ClaudeAccountsState>
  onChange: (cb: (state: ClaudeAccountsState) => void) => () => void
  add: (workspaceId: string | null) => Promise<AddAccountOutcome>
  remove: (id: string) => Promise<RemoveAccountOutcome>
  use: (id: string) => Promise<boolean>
  startFresh: () => Promise<boolean>
}

export interface ClaudeAccountsBridge {
  claudeAccounts: ClaudeAccountsApi
}
