import { ipcMain } from 'electron'
import type { WebStorageDump } from '../../shared/browser/browseRuntime'
import {
  type BrowserStorageRead,
  type BrowserStorageSnapshot,
  type StorageCookie,
  type StorageEdit,
  type StorageKind,
  type StorageRemoval,
  type StorageWriteResult,
  cookieUrl,
  entriesOf,
  isStorageKind,
  normalizeStorageEdit,
  normalizeStorageRemoval,
} from '../../shared/browser/browserStorage'
import { jsArgs, runInBrowseWorld } from './browseWorld'

type Outcome = { ok: true } | { ok: false; error: string; message?: string }

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function toStorageCookie(cookie: Electron.Cookie): StorageCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain ?? '',
    path: cookie.path ?? '/',
    hostOnly: cookie.hostOnly === true,
    expires: cookie.session || cookie.expirationDate === undefined ? null : cookie.expirationDate,
    httpOnly: cookie.httpOnly === true,
    secure: cookie.secure === true,
    sameSite: cookie.sameSite ?? 'unspecified',
  }
}

export async function listCookies(
  guest: Electron.WebContents,
  filter: Electron.CookiesGetFilter = {},
): Promise<StorageCookie[]> {
  const cookies = await guest.session.cookies.get(filter)
  return cookies.map(toStorageCookie)
}

export function readWebStorage(guest: Electron.WebContents): Promise<WebStorageDump> {
  return runInBrowseWorld<WebStorageDump>(guest, 'storage()')
}

export async function readStorage(guest: Electron.WebContents): Promise<BrowserStorageSnapshot> {
  const [cookies, web] = await Promise.all([listCookies(guest), readWebStorage(guest)])
  return {
    origin: web.origin,
    cookies,
    local: entriesOf(web.local),
    session: entriesOf(web.session),
  }
}

export async function writeCookie(
  guest: Electron.WebContents,
  cookie: StorageCookie,
): Promise<void> {
  await guest.session.cookies.set({
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    domain: cookie.hostOnly ? undefined : cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    expirationDate: cookie.expires ?? undefined,
  })
}

export async function writeStorage(
  guest: Electron.WebContents,
  edit: StorageEdit,
): Promise<Outcome> {
  try {
    if (edit.kind === 'cookies') {
      await writeCookie(guest, edit.cookie)
      return { ok: true }
    }
    return await runInBrowseWorld<Outcome>(
      guest,
      `setStorage(${jsArgs(edit.kind, edit.key, edit.value)})`,
    )
  } catch (e) {
    return { ok: false, error: 'storage-failed', message: errMessage(e) }
  }
}

export async function removeStorage(
  guest: Electron.WebContents,
  removal: StorageRemoval,
): Promise<Outcome> {
  try {
    if (removal.kind === 'cookies') {
      await guest.session.cookies.remove(cookieUrl(removal.cookie), removal.cookie.name)
      return { ok: true }
    }
    return await runInBrowseWorld<Outcome>(
      guest,
      `removeStorage(${jsArgs(removal.kind, removal.key)})`,
    )
  } catch (e) {
    return { ok: false, error: 'storage-failed', message: errMessage(e) }
  }
}

export async function clearStorage(
  guest: Electron.WebContents,
  kind: StorageKind,
): Promise<Outcome> {
  try {
    if (kind === 'cookies') {
      await guest.session.clearStorageData({ storages: ['cookies'] })
      return { ok: true }
    }
    return await runInBrowseWorld<Outcome>(guest, `clearStorage(${jsArgs(kind)})`)
  } catch (e) {
    return { ok: false, error: 'storage-failed', message: errMessage(e) }
  }
}

function asWriteResult(outcome: Outcome): StorageWriteResult {
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.message ?? outcome.error }
}

export type OwnedGuestLookup = (
  paneId: string,
  senderWindowId: string,
) => Electron.WebContents | null

export function registerBrowserStorageIpc(ownedGuest: OwnedGuestLookup): void {
  ipcMain.handle('browser:storage-read', async (e, paneId: string): Promise<BrowserStorageRead> => {
    const guest = ownedGuest(paneId, String(e.sender.id))
    if (!guest) return { ok: false, error: 'browser-not-ready' }
    try {
      return { ok: true, snapshot: await readStorage(guest) }
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
  })
  ipcMain.handle(
    'browser:storage-set',
    async (e, paneId: string, raw: unknown): Promise<StorageWriteResult> => {
      const guest = ownedGuest(paneId, String(e.sender.id))
      if (!guest) return { ok: false, error: 'browser-not-ready' }
      const edit = normalizeStorageEdit(raw)
      if (!edit) return { ok: false, error: 'invalid-entry' }
      return asWriteResult(await writeStorage(guest, edit))
    },
  )
  ipcMain.handle(
    'browser:storage-remove',
    async (e, paneId: string, raw: unknown): Promise<StorageWriteResult> => {
      const guest = ownedGuest(paneId, String(e.sender.id))
      if (!guest) return { ok: false, error: 'browser-not-ready' }
      const removal = normalizeStorageRemoval(raw)
      if (!removal) return { ok: false, error: 'invalid-entry' }
      return asWriteResult(await removeStorage(guest, removal))
    },
  )
  ipcMain.handle(
    'browser:storage-clear',
    async (e, paneId: string, kind: unknown): Promise<StorageWriteResult> => {
      const guest = ownedGuest(paneId, String(e.sender.id))
      if (!guest) return { ok: false, error: 'browser-not-ready' }
      if (!isStorageKind(kind)) return { ok: false, error: 'invalid-entry' }
      return asWriteResult(await clearStorage(guest, kind))
    },
  )
}
