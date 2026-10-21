import { type ClaudeAccountsState, NO_ACCOUNTS } from '@shared/claudeAccounts/claudeAccounts'
import { useEffect, useState } from 'react'

export function useClaudeAccounts(): ClaudeAccountsState {
  const [state, setState] = useState(NO_ACCOUNTS)
  useEffect(() => {
    const { claudeAccounts } = window.ostia
    const off = claudeAccounts.onChange(setState)
    void claudeAccounts.state().then(setState)
    return off
  }, [])
  return state
}
