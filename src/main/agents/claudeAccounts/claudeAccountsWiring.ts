import { homedir } from 'node:os'
import { ipcMain } from 'electron'
import type { Dict } from '../../../shared/app/dict'
import {
  accountOfTarget,
  type ClaudeAccountView,
  NO_ACCOUNTS,
  percentNow,
} from '../../../shared/claudeAccounts/claudeAccounts'
import { quoteArg } from '../../../shared/terminal/shellQuote'
import { approvals } from '../../approvals/approvals'
import { openCallbackListener } from '../../chat/mcpOAuth'
import type { CommandBridge } from '../../control/commandBridge'
import { type ControlMethodContext, registerControlMethod } from '../../control/controlServer'
import { type PaneIdentity, resolveExternal } from '../../control/idRegistry'
import { listWorkspaces } from '../../panes/paneList'
import { storePath } from '../../platform/jsonStore'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import type { ScratchFolders } from '../../workspaces/scratchFolders'
import type { AgentResumes } from '../agentResumes'
import type { AgentRunningPanes } from '../agentRunning'
import {
  accountEmail,
  accountsRoot,
  credentialsStamp,
  defaultConfigHome,
  loginState,
  usageToken,
  writeLogin,
} from './accountProfiles'
import { syncProfileFromDefault } from './accountSync'
import { ClaudeAccountsStore } from './accountsStore'
import { ClaudeAccounts, type LoginTarget } from './claudeAccounts'
import { createPkce, exchangeCode, fetchProfile } from './signIn/anthropicOAuth'
import { fetchUsage } from './usageApi'
import { UsagePoller } from './usagePoller'

const ACCOUNTS_DIR = 'claude-accounts'

interface CreateDeps {
  openTerminalInWindow: CommandBridge['openTerminalInWindow']
  openExternalSafe: (url: string) => boolean
  mainStrings: () => Dict
  broadcast: (channel: string, payload: unknown) => void
  agentRunning: Pick<AgentRunningPanes, 'has'>
}

export function createClaudeAccounts(deps: CreateDeps): ClaudeAccounts {
  const usage = new UsagePoller({
    targets: () => accounts.usageTargets(),
    token: (dir) => usageToken(dir, Date.now()),
    stamp: credentialsStamp,
    fetch: (accessToken) => fetchUsage(accessToken),
    onChange: () => void accounts.usageChanged(),
  })
  const accounts: ClaudeAccounts = new ClaudeAccounts({
    usage: process.platform === 'darwin' ? null : usage,
    store: new ClaudeAccountsStore(storePath(ACCOUNTS_DIR, 'global')),
    root: accountsRoot(),
    defaultHome: () => defaultConfigHome(),
    defaultEmail: () => accountEmail(process.env.CLAUDE_CONFIG_DIR || undefined),
    profileEmail: (dir) => accountEmail(dir),
    syncProfile: (dir) => syncProfileFromDefault(dir, defaultConfigHome()),
    loginState: (dir) => loginState(dir, Date.now()),
    writeLogin,
    signIn:
      process.platform === 'darwin'
        ? null
        : {
            listen: ({ state, timeoutMs }) =>
              openCallbackListener({
                state,
                timeoutMs,
                redirectName: 'localhost',
                pages: {
                  done: deps.mainStrings().claudeAccounts.signInPageDone,
                  failed: deps.mainStrings().claudeAccounts.signInPageFailed,
                },
              }),
            openExternal: deps.openExternalSafe,
            createPkce,
            exchange: (code, redirectUri, pkce) =>
              exchangeCode(code, redirectUri, pkce, Date.now()),
            profile: (accessToken) => fetchProfile(accessToken),
          },
    openLoginTab: (dir, target) =>
      deps.openTerminalInWindow({
        command: `CLAUDE_CONFIG_DIR=${quoteArg(dir)} 'claude'`,
        title: deps.mainStrings().claudeAccounts.loginTitle,
        workspaceId: target.workspaceId,
        windowId: target.windowId,
        cwd: homedir(),
      }),
    agentRunning: (paneId) => deps.agentRunning.has(paneId),
    paneOf: (externalId) => {
      const pane = resolveExternal(externalId)
      return pane?.kind === 'pane' ? pane.paneId : undefined
    },
    onChange: (state) => deps.broadcast('claude-accounts:changed', state),
  })
  return accounts
}

interface RegisterDeps {
  claudeAccounts: ClaudeAccounts
  agentResumes: AgentResumes
  workspaceSandboxes: Pick<WorkspaceSandboxes, 'isEnabled'>
  scratchFolders: Pick<ScratchFolders, 'isScratch'>
  workspaceWindowId: (workspaceId: string) => string | undefined
  execCommand: CommandBridge['execCommand']
  trustForStart: (profileDir: string, identity: PaneIdentity) => Promise<boolean>
  windowIds: () => string[]
}

const fromWindow = (e: Electron.IpcMainInvokeEvent): boolean => e.sender.getType() === 'window'

export function registerClaudeAccountsWiring(deps: RegisterDeps): void {
  const { claudeAccounts, workspaceSandboxes, scratchFolders } = deps
  void claudeAccounts.boot()

  const defaultOnly = (ctx: ControlMethodContext): 'manager' | 'sandboxed' | 'scratch' | null => {
    if (ctx.identity.manager === true) return 'manager'
    if (workspaceSandboxes.isEnabled(ctx.identity.workspaceId)) return 'sandboxed'
    return scratchFolders.isScratch(ctx.identity.workspaceId) ? 'scratch' : null
  }

  async function loginTarget(
    e: Electron.IpcMainInvokeEvent,
    workspaceId: unknown,
  ): Promise<LoginTarget | null> {
    if (typeof workspaceId !== 'string') return null
    const windowId = String(e.sender.id)
    if (deps.workspaceWindowId(workspaceId) !== windowId) return null
    if (workspaceSandboxes.isEnabled(workspaceId) || scratchFolders.isScratch(workspaceId)) {
      return null
    }
    const found = (await listWorkspaces(deps)).find((w) => w.workspaceId === workspaceId)
    return found?.kind === 'terminal' ? { workspaceId, windowId } : null
  }

  ipcMain.handle('claude-accounts:state', (e) =>
    fromWindow(e) ? claudeAccounts.state() : NO_ACCOUNTS,
  )
  ipcMain.handle('claude-accounts:add', async (e, workspaceId: unknown) => {
    if (!fromWindow(e)) return 'not-opened'
    const target = await loginTarget(e, workspaceId)
    return target ? claudeAccounts.add(target) : 'no-workspace'
  })
  ipcMain.handle('claude-accounts:begin-sign-in', (e, id: unknown) =>
    fromWindow(e) && (id === null || typeof id === 'string')
      ? claudeAccounts.beginSignIn(id)
      : 'unavailable',
  )
  ipcMain.handle('claude-accounts:open-sign-in', (e) =>
    fromWindow(e) ? claudeAccounts.openSignIn() : false,
  )
  ipcMain.handle('claude-accounts:submit-code', (e, code: unknown) =>
    fromWindow(e) && typeof code === 'string' ? claudeAccounts.submitSignIn(code) : 'idle',
  )
  ipcMain.handle('claude-accounts:cancel-sign-in', (e) => {
    if (fromWindow(e)) claudeAccounts.cancelSignIn()
  })
  ipcMain.handle('claude-accounts:remove', (e, id: unknown) =>
    fromWindow(e) && typeof id === 'string' ? claudeAccounts.remove(id) : 'unknown',
  )
  ipcMain.handle('claude-accounts:use', (e, id: unknown) =>
    fromWindow(e) && typeof id === 'string' ? claudeAccounts.use(id) : false,
  )
  ipcMain.handle('claude-accounts:set-enabled', (e, id: unknown, enabled: unknown) =>
    fromWindow(e) && typeof id === 'string' && typeof enabled === 'boolean'
      ? claudeAccounts.setEnabled(id, enabled)
      : 'unknown',
  )
  ipcMain.handle('claude-accounts:set-check-usage', (e, on: unknown) =>
    fromWindow(e) && typeof on === 'boolean' ? claudeAccounts.setCheckUsage(on) : false,
  )
  ipcMain.handle('claude-accounts:recover', (e) =>
    fromWindow(e) ? claudeAccounts.recover() : null,
  )

  registerControlMethod('claudeAccount.start', {
    handler: async (params, ctx) => {
      const args = (params as { args?: unknown } | null)?.args
      const argv = Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : []
      const dir = defaultOnly(ctx)
        ? ''
        : await claudeAccounts.startDirectory(argv, ctx.identity.paneId)
      await deps.trustForStart(dir, ctx.identity)
      return { dir }
    },
  })

  registerControlMethod('account.list', {
    cap: 'settings-read',
    handler: async (_params, ctx) => {
      const isolated = defaultOnly(ctx)
      if (isolated) return { ok: false, error: isolated }
      const { accounts, current } = await claudeAccounts.state()
      const now = Date.now()
      return {
        ok: true,
        accounts: accounts.map(({ id, email, enabled, usage }, i) => ({
          number: i + 1,
          email,
          current: id === current,
          enabled,
          session: percentNow(usage?.session ?? null, now),
          weekly: percentNow(usage?.weekly ?? null, now),
        })),
      }
    },
  })

  registerControlMethod('account.switch', {
    handler: async (params, ctx) => {
      const target = (params as { target?: unknown } | null)?.target
      if (typeof target !== 'string') return { ok: false, error: 'invalid-params' }
      const isolated = defaultOnly(ctx)
      if (isolated) return { ok: false, error: isolated }
      const { accounts } = await claudeAccounts.state()
      const account = accountOfTarget(accounts, target)
      if (!account) return { ok: false, error: 'unknown-account' }
      if (!account.enabled) return { ok: false, error: 'account-off' }
      if (!(await humanApproves(ctx, account))) return { ok: false, error: 'not-approved' }
      if (!(await claudeAccounts.use(account.id))) return { ok: false, error: 'unavailable' }
      return { ok: true, number: accounts.indexOf(account) + 1, email: account.email }
    },
  })

  deps.agentResumes.subscribe((externalPaneId, resume) => {
    if (resume.agent !== 'claude') return
    const pane = resolveExternal(externalPaneId)
    if (pane?.kind === 'pane') claudeAccounts.sessionStarted(pane.paneId, resume.id)
  })
}

async function humanApproves(
  ctx: ControlMethodContext,
  account: ClaudeAccountView,
): Promise<boolean> {
  const approver = approvals()
  const { identity } = ctx
  if (!approver || identity.kind !== 'pane') return false
  const subject = account.email ?? 'default'
  const outcome = await approver.request({
    externalId: identity.externalId,
    windowId: identity.windowId,
    paneId: identity.paneId,
    workspaceId: identity.workspaceId,
    caps: [],
    action: 'account.switch',
    detail: subject,
    kind: 'account-switch',
    subject,
  })
  return outcome === 'once'
}
