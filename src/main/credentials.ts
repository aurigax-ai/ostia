import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { BrowserWindow, clipboard, dialog, ipcMain, safeStorage } from 'electron'
import {
  CREDENTIAL_FIELD_MAX,
  type CredentialImportResult,
  type CredentialInput,
  type CredentialSaveResult,
  type CredentialSummary,
  normalizeOrigin,
  passwordRowsFromCsv,
} from '../shared/credentials'
import { loadJson, saveJson, storePath } from './jsonStore'

interface StoredCredential extends CredentialSummary {
  secret: string
}

export interface CredentialDeps {
  load: () => StoredCredential[]
  save: (list: StoredCredential[]) => void
  canEncrypt: () => boolean
  encrypt: (plain: string) => string
  decrypt: (secret: string) => string
  now: () => number
  newId: () => string
}

export interface CredentialStore {
  list: () => CredentialSummary[]
  save: (input: CredentialInput) => CredentialSaveResult
  remove: (id: string) => boolean
  password: (id: string) => string | null
  forOrigin: (url: string) => (CredentialSummary & { password: string })[]
  importRows: (rows: CredentialInput[]) => CredentialImportResult
}

const summary = ({ id, origin, username, updatedAt }: StoredCredential): CredentialSummary => ({
  id,
  origin,
  username,
  updatedAt,
})

export function createCredentialStore(deps: CredentialDeps): CredentialStore {
  const upsert = (
    list: StoredCredential[],
    input: CredentialInput,
  ): CredentialSaveResult & { list?: StoredCredential[] } => {
    const origin = normalizeOrigin(input.origin)
    if (!origin) return { ok: false, error: 'invalid-origin' }
    const username = input.username.trim().slice(0, CREDENTIAL_FIELD_MAX)
    if (!input.password || input.password.length > CREDENTIAL_FIELD_MAX) {
      return { ok: false, error: 'empty' }
    }
    const secret = deps.encrypt(input.password)
    const existing = list.find((c) => c.origin === origin && c.username === username)
    if (existing) {
      existing.secret = secret
      existing.updatedAt = deps.now()
      return { ok: true, id: existing.id, updated: true, list }
    }
    const id = deps.newId()
    list.push({ id, origin, username, secret, updatedAt: deps.now() })
    return { ok: true, id, updated: false, list }
  }

  return {
    list: () =>
      deps
        .load()
        .map(summary)
        .sort((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)),
    save: (input) => {
      if (!deps.canEncrypt()) return { ok: false, error: 'encryption-unavailable' }
      const list = deps.load()
      const { list: next, ...result } = upsert(list, input)
      if (next) deps.save(next)
      return result
    },
    remove: (id) => {
      const list = deps.load()
      const next = list.filter((c) => c.id !== id)
      if (next.length === list.length) return false
      deps.save(next)
      return true
    },
    password: (id) => {
      const entry = deps.load().find((c) => c.id === id)
      return entry && deps.canEncrypt() ? deps.decrypt(entry.secret) : null
    },
    forOrigin: (url) => {
      const origin = normalizeOrigin(url)
      if (!origin || !deps.canEncrypt()) return []
      return deps
        .load()
        .filter((c) => c.origin === origin)
        .map((c) => ({ ...summary(c), password: deps.decrypt(c.secret) }))
    },
    importRows: (rows) => {
      if (!deps.canEncrypt()) return { ok: false, error: 'encryption-unavailable' }
      const list = deps.load()
      let imported = 0
      let updated = 0
      let skipped = 0
      for (const row of rows) {
        const result = upsert(list, row)
        if (!result.ok) skipped += 1
        else if (result.updated) updated += 1
        else imported += 1
      }
      deps.save(list)
      return { ok: true, imported, updated, skipped }
    },
  }
}

let active: CredentialStore | null = null

export function credentials(): CredentialStore | null {
  return active
}

export function registerCredentials(): void {
  const path = storePath('credentials', 'global')
  const store = createCredentialStore({
    load: () => loadJson<StoredCredential[]>(path, []),
    save: (list) => saveJson(path, list, { secure: true }),
    canEncrypt: () => safeStorage.isEncryptionAvailable(),
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (secret) => safeStorage.decryptString(Buffer.from(secret, 'base64')),
    now: Date.now,
    newId: randomUUID,
  })
  active = store
  ipcMain.handle('credentials:list', () => store.list())
  ipcMain.handle('credentials:save', (_e, input: CredentialInput) =>
    store.save({
      origin: String(input?.origin ?? ''),
      username: String(input?.username ?? ''),
      password: String(input?.password ?? ''),
    }),
  )
  ipcMain.handle('credentials:remove', (_e, id: unknown) =>
    typeof id === 'string' ? store.remove(id) : false,
  )
  ipcMain.handle('credentials:copy-password', async (_e, id: unknown) => {
    const password = typeof id === 'string' ? store.password(id) : null
    if (password === null) return false
    await clipboard.writeText(password)
    return true
  })
  ipcMain.handle('credentials:import', async (e): Promise<CredentialImportResult> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const options: Electron.OpenDialogOptions = {
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const file = picked.filePaths[0]
    if (picked.canceled || !file) return { ok: false, error: 'cancelled' }
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return { ok: false, error: 'unreadable' }
    }
    const rows = passwordRowsFromCsv(text)
    if (!rows) return { ok: false, error: 'no-columns' }
    return store.importRows(rows)
  })
}
