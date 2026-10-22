import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { DEFAULT_ACCOUNT, isProfileId } from '../../../shared/claudeAccounts/claudeAccounts'
import { saveJson } from '../../platform/jsonStore'

const FORMAT = 1
const SESSIONS_MAX = 500
const PANES_MAX = 256
const EMAIL_MAX = 320

export interface StoredAccount {
  id: string
  email: string
  addedAt: number
}

interface StoredAccounts {
  accounts: StoredAccount[]
  current: string
  sessions: Record<string, string>
  panes: Record<string, string>
}

function parseAccount(raw: unknown): StoredAccount | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { id, email, addedAt } = raw as Record<string, unknown>
  if (!isProfileId(id) || typeof email !== 'string' || email === '' || email.length > EMAIL_MAX)
    return null
  return { id, email, addedAt: typeof addedAt === 'number' ? addedAt : 0 }
}

function parseStored(raw: unknown): StoredAccounts | null {
  if (typeof raw !== 'object' || raw === null) return null
  const stored = raw as Record<string, unknown>
  if (stored.v !== FORMAT || !Array.isArray(stored.accounts)) return null
  const accounts: StoredAccount[] = []
  for (const entry of stored.accounts) {
    const account = parseAccount(entry)
    if (!account) return null
    accounts.push(account)
  }
  const known = new Set(accounts.map((account) => account.id))
  const current =
    typeof stored.current === 'string' && known.has(stored.current)
      ? stored.current
      : DEFAULT_ACCOUNT
  return {
    accounts,
    current,
    sessions: knownAccounts(stored.sessions, known),
    panes: knownAccounts(stored.panes, known),
  }
}

function knownAccounts(raw: unknown, known: ReadonlySet<string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [key, account] of Object.entries(raw)) {
    if (typeof account === 'string' && (account === DEFAULT_ACCOUNT || known.has(account)))
      out[key] = account
  }
  return out
}

const EMPTY = (): StoredAccounts => ({
  accounts: [],
  current: DEFAULT_ACCOUNT,
  sessions: {},
  panes: {},
})

export class ClaudeAccountsStore {
  private data: StoredAccounts = EMPTY()
  private damaged = false

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!existsSync(file)) return
    const parsed = this.read()
    if (parsed) {
      this.data = parsed
      return
    }
    this.damaged = true
    const aside = `${file}.corrupt-${this.now()}`
    try {
      renameSync(file, aside)
      chmodSync(aside, 0o600)
    } catch {
      return
    }
  }

  get isDamaged(): boolean {
    return this.damaged
  }

  startFresh(): boolean {
    if (!this.damaged) return false
    this.damaged = false
    this.data = EMPTY()
    this.save()
    return true
  }

  accounts(): readonly StoredAccount[] {
    return this.data.accounts
  }

  has(id: string): boolean {
    return this.data.accounts.some((account) => account.id === id)
  }

  current(): string {
    return this.data.current
  }

  add(account: StoredAccount): boolean {
    if (this.damaged) return false
    this.data.accounts = [...this.data.accounts, account]
    this.save()
    return true
  }

  remove(id: string): boolean {
    if (this.damaged || !this.has(id)) return false
    this.data.accounts = this.data.accounts.filter((account) => account.id !== id)
    if (this.data.current === id) this.data.current = DEFAULT_ACCOUNT
    const kept = ([, account]: [string, string]) => account !== id
    this.data.sessions = Object.fromEntries(Object.entries(this.data.sessions).filter(kept))
    this.data.panes = Object.fromEntries(Object.entries(this.data.panes).filter(kept))
    this.save()
    return true
  }

  use(id: string): boolean {
    if (this.damaged || (id !== DEFAULT_ACCOUNT && !this.has(id))) return false
    this.data.current = id
    this.save()
    return true
  }

  accountOfSession(sessionId: string): string | undefined {
    return Object.hasOwn(this.data.sessions, sessionId) ? this.data.sessions[sessionId] : undefined
  }

  rememberPane(paneId: string, accountId: string): void {
    if (this.damaged || (accountId !== DEFAULT_ACCOUNT && !this.has(accountId))) return
    if (this.data.panes[paneId] === accountId) return
    const panes = Object.entries(this.data.panes).filter(([id]) => id !== paneId)
    panes.push([paneId, accountId])
    this.data.panes = Object.fromEntries(panes.slice(-PANES_MAX))
    this.save()
  }

  accountOfPane(paneId: string): string | undefined {
    return Object.hasOwn(this.data.panes, paneId) ? this.data.panes[paneId] : undefined
  }

  panesOn(accountId: string): string[] {
    return Object.entries(this.data.panes).flatMap(([id, account]) =>
      account === accountId ? [id] : [],
    )
  }

  rememberSession(sessionId: string, accountId: string): void {
    if (this.damaged || (accountId !== DEFAULT_ACCOUNT && !this.has(accountId))) return
    if (this.data.sessions[sessionId] === accountId) return
    const sessions = Object.entries(this.data.sessions).filter(([id]) => id !== sessionId)
    sessions.push([sessionId, accountId])
    this.data.sessions = Object.fromEntries(sessions.slice(-SESSIONS_MAX))
    this.save()
  }

  private read(): StoredAccounts | null {
    try {
      return parseStored(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      return null
    }
  }

  private save(): void {
    saveJson(this.file, { v: FORMAT, ...this.data }, { secure: true })
  }
}
