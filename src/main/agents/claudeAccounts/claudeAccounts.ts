import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  type AddAccountOutcome,
  type BeginSignInOutcome,
  type ClaudeAccountsState,
  DEFAULT_ACCOUNT,
  type RemoveAccountOutcome,
  type SetEnabledOutcome,
  type SubmitCodeOutcome,
} from '../../../shared/claudeAccounts/claudeAccounts'
import {
  acceptedProfileFolders,
  acceptProfile,
  createProfile,
  credentialsPresent,
  type LoginState,
  removeProfile,
  sweepPendingProfiles,
} from './accountProfiles'
import type { ClaudeAccountsStore } from './accountsStore'
import type { OAuthProfile, OAuthTokens } from './signIn/anthropicOAuth'
import { ClaudeSignIn, type CompleteOutcome, type SignInDeps } from './signIn/claudeSignIn'
import type { UsagePoller, UsageTarget } from './usagePoller'

const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000
const DUPLICATE_SHOWN_MS = 8000

export interface LoginTarget {
  workspaceId: string
  windowId: string
}

export interface ClaudeAccountsDeps {
  store: ClaudeAccountsStore
  root: string
  defaultHome: () => string
  defaultEmail: () => Promise<string | null>
  profileEmail: (dir: string) => Promise<string | null>
  syncProfile: (dir: string) => Promise<void>
  loginState: (dir: string) => Promise<LoginState>
  writeLogin: (dir: string, tokens: OAuthTokens, profile: OAuthProfile) => Promise<boolean>
  signIn: Omit<SignInDeps, 'complete' | 'onChange'> | null
  usage: Pick<UsagePoller, 'run' | 'usageOf'> | null
  openLoginTab: (dir: string, target: LoginTarget) => Promise<string | null>
  agentRunning: (paneId: string) => boolean
  paneOf: (externalPaneId: string) => string | undefined
  onChange: (state: ClaudeAccountsState) => void
  now?: () => number
  pollMs?: number
  timeoutMs?: number
  duplicateMs?: number
}

interface PendingLogin {
  id: string
  dir: string
  paneId: string
  startedAt: number
  timer: NodeJS.Timeout
}

export class ClaudeAccounts {
  private pending: PendingLogin | null = null
  private duplicate: string | null = null
  private duplicateTimer: NodeJS.Timeout | null = null
  private recoverable: { id: string; email: string }[] = []

  private readonly signIn: ClaudeSignIn | null

  constructor(private readonly deps: ClaudeAccountsDeps) {
    this.signIn = deps.signIn
      ? new ClaudeSignIn({
          ...deps.signIn,
          complete: (target, tokens, profile) => this.completeSignIn(target, tokens, profile),
          onChange: () => void this.publish(),
        })
      : null
  }

  async state(): Promise<ClaudeAccountsState> {
    const { store } = this.deps
    const usageOf = (id: string) => this.deps.usage?.usageOf(id) ?? null
    const profiles = await Promise.all(
      store.accounts().map(async ({ id, email }) => ({
        id,
        email,
        signedOut: (await this.deps.loginState(join(this.deps.root, id))) === 'signed-out',
        enabled: store.isEnabled(id),
        usage: store.isEnabled(id) ? usageOf(id) : null,
      })),
    )
    return {
      accounts: [
        {
          id: DEFAULT_ACCOUNT,
          email: await this.deps.defaultEmail(),
          signedOut: false,
          enabled: true,
          usage: usageOf(DEFAULT_ACCOUNT),
        },
        ...profiles,
      ],
      current: store.current(),
      adding: this.pending !== null,
      signInAvailable: this.signIn !== null,
      signIn: this.signIn?.status ?? 'idle',
      duplicate: this.duplicate,
      damaged: store.isDamaged,
      recoverable: this.recoverable.length,
      checkUsage: this.deps.usage !== null && store.checkUsage(),
      usageAvailable: this.deps.usage !== null,
    }
  }

  async boot(): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    await sweepPendingProfiles(
      this.deps.root,
      this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS,
      now,
      new Set(this.deps.store.accounts().map((account) => account.id)),
      async (dir) => credentialsPresent(dir) && (await this.deps.profileEmail(dir)) !== null,
    )
    this.recoverable = await this.unlistedLogins()
    if (this.recoverable.length > 0) await this.publish()
    this.deps.usage?.run(this.deps.store.checkUsage())
  }

  async setCheckUsage(on: boolean): Promise<boolean> {
    const { usage } = this.deps
    if (!usage || !this.deps.store.setCheckUsage(on)) return false
    usage.run(on)
    await this.publish()
    return true
  }

  async usageTargets(): Promise<UsageTarget[]> {
    const { store, root } = this.deps
    const profiles = await Promise.all(
      store
        .accounts()
        .filter(({ id }) => store.isEnabled(id))
        .map(async ({ id }) => ({
          id,
          dir: join(root, id),
          signedOut: (await this.deps.loginState(join(root, id))) === 'signed-out',
        })),
    )
    return [
      { id: DEFAULT_ACCOUNT, dir: this.deps.defaultHome() },
      ...profiles.filter((profile) => !profile.signedOut).map(({ id, dir }) => ({ id, dir })),
    ]
  }

  async usageChanged(): Promise<void> {
    await this.publish()
  }

  async recover(): Promise<number | null> {
    const { store } = this.deps
    const wasDamaged = store.isDamaged
    if (wasDamaged) store.startFresh()
    const found = await this.unlistedLogins()
    if (!wasDamaged && found.length === 0) return null
    for (const { id, email } of found)
      store.add({ id, email, addedAt: (this.deps.now ?? Date.now)() })
    this.recoverable = []
    await this.publish()
    return found.length
  }

  async add(target: LoginTarget): Promise<AddAccountOutcome> {
    if (this.deps.store.isDamaged) return 'damaged'
    if (this.pending || this.signIn?.busy) return 'busy'
    const id = randomBytes(8).toString('hex')
    const dir = createProfile(this.deps.root, id, this.deps.defaultHome())
    const paneId = await this.deps.openLoginTab(dir, target)
    if (!paneId) {
      await removeProfile(this.deps.root, id)
      return 'not-opened'
    }
    this.clearDuplicate()
    const timer = setInterval(() => void this.check(), this.deps.pollMs ?? LOGIN_POLL_MS)
    timer.unref?.()
    this.pending = { id, dir, paneId, startedAt: (this.deps.now ?? Date.now)(), timer }
    await this.publish()
    return 'opened'
  }

  async beginSignIn(id: string | null): Promise<BeginSignInOutcome> {
    const { store } = this.deps
    if (!this.signIn) return 'unavailable'
    if (store.isDamaged) return 'damaged'
    if (id !== null && !store.has(id)) return 'unknown'
    if (this.pending) return 'busy'
    this.clearDuplicate()
    return this.signIn.begin(id)
  }

  openSignIn(): boolean {
    return this.signIn?.open() ?? false
  }

  submitSignIn(code: string): SubmitCodeOutcome {
    return this.signIn?.submit(code) ?? 'idle'
  }

  cancelSignIn(): void {
    this.signIn?.cancel()
  }

  async paneClosed(externalPaneId: string): Promise<void> {
    if (this.pending?.paneId !== externalPaneId) return
    if (!(await this.check())) await this.cancel()
  }

  async remove(id: string): Promise<RemoveAccountOutcome> {
    const { store } = this.deps
    if (store.isDamaged) return 'damaged'
    if (!store.has(id)) return 'unknown'
    if (this.runningOn(id)) return 'running'
    store.remove(id)
    await removeProfile(this.deps.root, id)
    await this.publish()
    return 'removed'
  }

  async setEnabled(id: string, enabled: boolean): Promise<SetEnabledOutcome> {
    const { store } = this.deps
    if (store.isDamaged) return 'damaged'
    if (id === DEFAULT_ACCOUNT) return 'default'
    if (!store.has(id)) return 'unknown'
    if (!enabled && store.current() === id) return 'current'
    store.setEnabled(id, enabled)
    await this.publish()
    return 'done'
  }

  async use(id: string): Promise<boolean> {
    if (!this.deps.store.use(id)) return false
    await this.publish()
    return true
  }

  async startDirectory(paneId: string): Promise<string> {
    const account = this.deps.store.current()
    this.deps.store.rememberPane(paneId, account)
    if (account === DEFAULT_ACCOUNT) return ''
    const dir = join(this.deps.root, account)
    await this.deps.syncProfile(dir)
    return dir
  }

  defaultHome(): string {
    return this.deps.defaultHome()
  }

  current(): string {
    return this.deps.store.current()
  }

  accountOfPane(paneId: string): string | undefined {
    return this.deps.store.accountOfPane(paneId)
  }

  configDir(): string | undefined {
    const account = this.deps.store.current()
    return account === DEFAULT_ACCOUNT ? undefined : join(this.deps.root, account)
  }

  private runningOn(id: string): boolean {
    return this.deps.store.panesOn(id).some((paneId) => this.deps.agentRunning(paneId))
  }

  private async check(): Promise<boolean> {
    const pending = this.pending
    if (!pending) return false
    const email = credentialsPresent(pending.dir) ? await this.deps.profileEmail(pending.dir) : null
    if (this.pending !== pending) return false
    if (email) {
      await this.finish(pending, email)
      return true
    }
    const waited = (this.deps.now ?? Date.now)() - pending.startedAt
    if (waited > (this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS)) await this.cancel()
    return false
  }

  private async finish(pending: PendingLogin, email: string): Promise<void> {
    clearInterval(pending.timer)
    this.pending = null
    const added =
      !(await this.knownEmail(email)) &&
      this.deps.store.add({ id: pending.id, email, addedAt: (this.deps.now ?? Date.now)() })
    if (added) {
      await acceptProfile(this.deps.root, pending.id)
      const pane = this.deps.paneOf(pending.paneId)
      if (pane) this.deps.store.rememberPane(pane, pending.id)
    } else {
      await removeProfile(this.deps.root, pending.id)
      this.showDuplicate(email)
    }
    await this.publish()
  }

  private async knownEmail(email: string): Promise<boolean> {
    const known = [
      await this.deps.defaultEmail(),
      ...this.deps.store.accounts().map((account) => account.email),
    ]
    return known.some((other) => other?.toLowerCase() === email.toLowerCase())
  }

  private async completeSignIn(
    target: string | null,
    tokens: OAuthTokens,
    profile: OAuthProfile,
  ): Promise<CompleteOutcome> {
    const { store, root } = this.deps
    const email = profile.emailAddress
    if (target !== null) {
      const account = store.accounts().find((entry) => entry.id === target)
      if (!account) return 'failed'
      if (account.email?.toLowerCase() !== email.toLowerCase()) return 'mismatch'
      return (await this.deps.writeLogin(join(root, target), tokens, profile)) ? 'done' : 'failed'
    }
    if (await this.knownEmail(email)) {
      this.showDuplicate(email)
      return 'done'
    }
    const id = randomBytes(8).toString('hex')
    const dir = createProfile(root, id, this.deps.defaultHome())
    const written = await this.deps.writeLogin(dir, tokens, profile)
    if (!written || !store.add({ id, email, addedAt: (this.deps.now ?? Date.now)() })) {
      await removeProfile(root, id)
      return 'failed'
    }
    await acceptProfile(root, id)
    return 'done'
  }

  private showDuplicate(email: string): void {
    this.clearDuplicate()
    this.duplicate = email
    this.duplicateTimer = setTimeout(() => {
      this.duplicate = null
      this.duplicateTimer = null
      void this.publish()
    }, this.deps.duplicateMs ?? DUPLICATE_SHOWN_MS)
    this.duplicateTimer.unref?.()
  }

  private clearDuplicate(): void {
    if (this.duplicateTimer) clearTimeout(this.duplicateTimer)
    this.duplicateTimer = null
    this.duplicate = null
  }

  private async cancel(): Promise<void> {
    const pending = this.pending
    if (!pending) return
    clearInterval(pending.timer)
    this.pending = null
    await removeProfile(this.deps.root, pending.id)
    await this.publish()
  }

  private async unlistedLogins(): Promise<{ id: string; email: string }[]> {
    const listed = new Set(this.deps.store.accounts().map((account) => account.id))
    const taken = new Set(
      [await this.deps.defaultEmail(), ...this.deps.store.accounts().map((a) => a.email)].flatMap(
        (email) => (email ? [email.toLowerCase()] : []),
      ),
    )
    const found: { id: string; email: string }[] = []
    for (const id of await acceptedProfileFolders(this.deps.root)) {
      if (listed.has(id) || !credentialsPresent(join(this.deps.root, id))) continue
      const email = await this.deps.profileEmail(join(this.deps.root, id))
      if (!email || taken.has(email.toLowerCase())) continue
      taken.add(email.toLowerCase())
      found.push({ id, email })
    }
    return found
  }

  private async publish(): Promise<void> {
    this.deps.onChange(await this.state())
  }
}
