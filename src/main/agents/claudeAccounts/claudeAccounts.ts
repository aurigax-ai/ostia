import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  type AddAccountOutcome,
  type ClaudeAccountsState,
  DEFAULT_ACCOUNT,
  sessionIdOfArgs,
} from '../../../shared/claudeAccounts/claudeAccounts'
import { createProfile, credentialsPresent, removeProfile, sweepProfiles } from './accountProfiles'
import type { ClaudeAccountsStore } from './accountsStore'

const LOGIN_POLL_MS = 2000
const LOGIN_TIMEOUT_MS = 30 * 60 * 1000
const PANE_ACCOUNTS_MAX = 256

export interface ClaudeAccountsDeps {
  store: ClaudeAccountsStore
  root: string
  defaultHome: () => string
  defaultEmail: () => Promise<string | null>
  profileEmail: (dir: string) => Promise<string | null>
  openLoginTab: (dir: string) => Promise<string | null>
  onChange: (state: ClaudeAccountsState) => void
  now?: () => number
  pollMs?: number
  timeoutMs?: number
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
  private readonly paneAccounts = new Map<string, string>()

  constructor(private readonly deps: ClaudeAccountsDeps) {}

  async state(): Promise<ClaudeAccountsState> {
    const { store } = this.deps
    return {
      accounts: [
        { id: DEFAULT_ACCOUNT, email: await this.deps.defaultEmail() },
        ...store.accounts().map(({ id, email }) => ({ id, email })),
      ],
      current: store.current(),
      adding: this.pending !== null,
      duplicate: this.duplicate,
    }
  }

  sweepOrphans(): void {
    sweepProfiles(this.deps.root, new Set(this.deps.store.accounts().map((account) => account.id)))
  }

  async add(): Promise<AddAccountOutcome> {
    if (this.pending) return 'busy'
    const id = randomBytes(8).toString('hex')
    const dir = createProfile(this.deps.root, id, this.deps.defaultHome())
    const paneId = await this.deps.openLoginTab(dir)
    if (!paneId) {
      removeProfile(this.deps.root, id)
      return 'not-opened'
    }
    this.duplicate = null
    const timer = setInterval(() => void this.check(), this.deps.pollMs ?? LOGIN_POLL_MS)
    timer.unref?.()
    this.pending = { id, dir, paneId, startedAt: (this.deps.now ?? Date.now)(), timer }
    await this.publish()
    return 'opened'
  }

  async paneClosed(externalPaneId: string): Promise<void> {
    if (this.pending?.paneId !== externalPaneId) return
    if (!(await this.check())) this.cancel()
  }

  async remove(id: string): Promise<boolean> {
    if (!this.deps.store.remove(id)) return false
    removeProfile(this.deps.root, id)
    await this.publish()
    return true
  }

  async use(id: string): Promise<boolean> {
    if (!this.deps.store.use(id)) return false
    await this.publish()
    return true
  }

  startDirectory(args: readonly string[], paneId: string): string {
    const account = this.accountFor(sessionIdOfArgs(args))
    this.paneAccounts.delete(paneId)
    this.paneAccounts.set(paneId, account)
    if (this.paneAccounts.size > PANE_ACCOUNTS_MAX) {
      const oldest = this.paneAccounts.keys().next().value
      if (oldest !== undefined) this.paneAccounts.delete(oldest)
    }
    return account === DEFAULT_ACCOUNT ? '' : join(this.deps.root, account)
  }

  configDirFor(sessionId: string | null): string | undefined {
    const account = this.accountFor(sessionId)
    return account === DEFAULT_ACCOUNT ? undefined : join(this.deps.root, account)
  }

  sessionStarted(paneId: string, sessionId: string): void {
    const account = this.paneAccounts.get(paneId)
    if (account) this.deps.store.rememberSession(sessionId, account)
  }

  private accountFor(sessionId: string | null): string {
    const { store } = this.deps
    const remembered = sessionId ? store.accountOfSession(sessionId) : undefined
    return remembered && (remembered === DEFAULT_ACCOUNT || store.has(remembered))
      ? remembered
      : store.current()
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
    if (
      (this.deps.now ?? Date.now)() - pending.startedAt >
      (this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS)
    ) {
      this.cancel()
    }
    return false
  }

  private async finish(pending: PendingLogin, email: string): Promise<void> {
    clearInterval(pending.timer)
    this.pending = null
    const known = [
      await this.deps.defaultEmail(),
      ...this.deps.store.accounts().map((account) => account.email),
    ]
    if (known.some((other) => other?.toLowerCase() === email.toLowerCase())) {
      removeProfile(this.deps.root, pending.id)
      this.duplicate = email
    } else {
      this.deps.store.add({ id: pending.id, email, addedAt: (this.deps.now ?? Date.now)() })
    }
    await this.publish()
  }

  private cancel(): void {
    const pending = this.pending
    if (!pending) return
    clearInterval(pending.timer)
    this.pending = null
    removeProfile(this.deps.root, pending.id)
    void this.publish()
  }

  private async publish(): Promise<void> {
    this.deps.onChange(await this.state())
  }
}
