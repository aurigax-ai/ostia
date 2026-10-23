import type {
  AddAccountOutcome,
  BeginSignInOutcome,
  ClaudeAccountsState,
  RemoveAccountOutcome,
  SetEnabledOutcome,
  SubmitCodeOutcome,
} from './claudeAccounts'

interface ClaudeAccountsApi {
  state: () => Promise<ClaudeAccountsState>
  onChange: (cb: (state: ClaudeAccountsState) => void) => () => void
  add: (workspaceId: string | null) => Promise<AddAccountOutcome>
  remove: (id: string) => Promise<RemoveAccountOutcome>
  use: (id: string) => Promise<boolean>
  recover: () => Promise<number | null>
  setCheckUsage: (on: boolean) => Promise<boolean>
  setEnabled: (id: string, enabled: boolean) => Promise<SetEnabledOutcome>
  beginSignIn: (id: string | null) => Promise<BeginSignInOutcome>
  openSignIn: () => Promise<boolean>
  submitSignInCode: (code: string) => Promise<SubmitCodeOutcome>
  cancelSignIn: () => Promise<void>
}

export interface ClaudeAccountsBridge {
  claudeAccounts: ClaudeAccountsApi
}
