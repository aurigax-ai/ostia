import { join } from 'node:path'
import { ipcMain } from 'electron'
import type { Dict } from '../../../shared/app/dict'
import { accountOfTarget, NO_ACCOUNTS } from '../../../shared/claudeAccounts/claudeAccounts'
import { quoteArg } from '../../../shared/terminal/shellQuote'
import type { CommandBridge } from '../../control/commandBridge'
import { registerControlMethod } from '../../control/controlServer'
import { resolveExternal } from '../../control/idRegistry'
import { storePath } from '../../platform/jsonStore'
import { appDataDir } from '../../platform/userDirs'
import type { HostPaneGrants } from '../../sandbox/hostPanes'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import type { AgentResumes } from '../agentResumes'
import { accountEmail, defaultConfigHome } from './accountProfiles'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts } from './claudeAccounts'

const LOGIN_GRANT_ID = 'core:claude-account'
const ACCOUNTS_DIR = 'claude-accounts'

interface CreateDeps {
  openTerminalInWindow: CommandBridge['openTerminalInWindow']
  hostPaneGrants: HostPaneGrants
  mainStrings: () => Dict
  broadcast: (channel: string, payload: unknown) => void
}

export function createClaudeAccounts(deps: CreateDeps): ClaudeAccounts {
  return new ClaudeAccounts({
    store: new ClaudeAccountsStore(storePath(ACCOUNTS_DIR, 'global')),
    root: join(appDataDir(), ACCOUNTS_DIR),
    defaultHome: () => defaultConfigHome(),
    defaultEmail: () => accountEmail(process.env.CLAUDE_CONFIG_DIR || undefined),
    profileEmail: (dir) => accountEmail(dir),
    openLoginTab: (dir) => {
      const command = `CLAUDE_CONFIG_DIR=${quoteArg(dir)} 'claude'`
      deps.hostPaneGrants.offer(LOGIN_GRANT_ID, command)
      return deps.openTerminalInWindow({
        command,
        hostToken: deps.hostPaneGrants.claim(LOGIN_GRANT_ID, command) ?? '',
        title: deps.mainStrings().claudeAccounts.loginTitle,
      })
    },
    onChange: (state) => deps.broadcast('claude-accounts:changed', state),
  })
}

interface RegisterDeps {
  claudeAccounts: ClaudeAccounts
  agentResumes: AgentResumes
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
}

export function registerClaudeAccountsWiring({
  claudeAccounts,
  agentResumes,
  workspaceSandboxes,
}: RegisterDeps): void {
  claudeAccounts.sweepOrphans()
  const fromWindow = (e: Electron.IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

  ipcMain.handle('claude-accounts:state', (e) =>
    fromWindow(e) ? claudeAccounts.state() : NO_ACCOUNTS,
  )
  ipcMain.handle('claude-accounts:add', (e) =>
    fromWindow(e) ? claudeAccounts.add() : 'not-opened',
  )
  ipcMain.handle('claude-accounts:remove', (e, id: unknown) =>
    fromWindow(e) && typeof id === 'string' ? claudeAccounts.remove(id) : false,
  )
  ipcMain.handle('claude-accounts:use', (e, id: unknown) =>
    fromWindow(e) && typeof id === 'string' ? claudeAccounts.use(id) : false,
  )

  registerControlMethod('claudeAccount.start', {
    handler: (params, { identity }) => {
      const args = (params as { args?: unknown } | null)?.args
      if (identity.manager === true || workspaceSandboxes.isEnabled(identity.workspaceId)) {
        return { dir: '' }
      }
      const argv = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
      return { dir: claudeAccounts.startDirectory(argv, identity.paneId) }
    },
  })

  registerControlMethod('account.list', {
    cap: 'settings-read',
    handler: async () => {
      const { accounts, current } = await claudeAccounts.state()
      return {
        accounts: accounts.map(({ id, email }, i) => ({
          number: i + 1,
          email,
          current: id === current,
        })),
      }
    },
  })

  registerControlMethod('account.switch', {
    cap: 'settings-write',
    handler: async (params) => {
      const target = (params as { target?: unknown } | null)?.target
      if (typeof target !== 'string') return { ok: false, error: 'invalid-params' }
      const { accounts } = await claudeAccounts.state()
      const account = accountOfTarget(accounts, target)
      if (!account) return { ok: false, error: 'unknown-account' }
      await claudeAccounts.use(account.id)
      return { ok: true, number: accounts.indexOf(account) + 1, email: account.email }
    },
  })

  agentResumes.subscribe((externalPaneId, resume) => {
    if (resume.agent !== 'claude') return
    const pane = resolveExternal(externalPaneId)
    if (pane?.kind === 'pane') claudeAccounts.sessionStarted(pane.paneId, resume.id)
  })
}
