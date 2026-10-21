import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import {
  type AddAccountOutcome,
  type ClaudeAccountsState,
  DEFAULT_ACCOUNT,
  type RemoveAccountOutcome,
  sessionIdOfArgs,
} from '../../../shared/claudeAccounts/claudeAccounts'
import {
  acceptedProfileFolders,
  acceptProfile,
  createProfile,
  credentialsPresent,
  removeProfile,
  sweepPendingProfiles,
} from './accountProfiles'
import type { ClaudeAccountsStore } from './accountsStore'

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
  openLoginTab: (dir: string, target: LoginTarget) => Promise<string | null>
  agentRunning: (paneId: string) => boolean
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
      damaged: store.isDamaged,
      recoverable: this.recoverable.length,
    }
  }

  async boot(): Promise<void> {
    const now = (this.deps.now ?? Date.now)()
    await sweepPendingProfiles(this.deps.root, this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS, now)
    this.recoverable = await this.unlistedLogins()
    if (this.recoverable.length > 0) await this.publish()
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
    if (this.pending) return 'busy'
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

  async use(id: string): Promise<boolean> {
    if (!this.deps.store.use(id)) return false
    await this.publish()
    return true
  }

  async startDirectory(args: readonly string[], paneId: string): Promise<string> {
    const account = this.accountFor(sessionIdOfArgs(args))
    this.deps.store.rememberPane(paneId, account)
    if (account === DEFAULT_ACCOUNT) return ''
    const dir = join(this.deps.root, account)
    await this.deps.syncProfile(dir)
    return dir
  }

  configDirFor(sessionId: string | null): string | undefined {
    const account = this.accountFor(sessionId)
    return account === DEFAULT_ACCOUNT ? undefined : join(this.deps.root, account)
  }

  sessionStarted(paneId: string, sessionId: string): void {
    const account = this.deps.store.accountOfPane(paneId)
    if (account) this.deps.store.rememberSession(sessionId, account)
  }

  private runningOn(id: string): boolean {
    return this.deps.store.panesOn(id).some((paneId) => this.deps.agentRunning(paneId))
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
    const waited = (this.deps.now ?? Date.now)() - pending.startedAt
    if (waited > (this.deps.timeoutMs ?? LOGIN_TIMEOUT_MS)) await this.cancel()
    return false
  }

  private async finish(pending: PendingLogin, email: string): Promise<void> {
    clearInterval(pending.timer)
    this.pending = null
    const known = [
      await this.deps.defaultEmail(),
      ...this.deps.store.accounts().map((account) => account.email),
    ]
    const added =
      !known.some((other) => other?.toLowerCase() === email.toLowerCase()) &&
      this.deps.store.add({ id: pending.id, email, addedAt: (this.deps.now ?? Date.now)() })
    if (added) await acceptProfile(this.deps.root, pending.id)
    else {
      await removeProfile(this.deps.root, pending.id)
      this.showDuplicate(email)
    }
    await this.publish()
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
