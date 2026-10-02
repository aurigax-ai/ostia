import { ipcMain } from 'electron'
import type { CredentialSummary } from '../shared/credentials'
import { normalizeOrigin } from '../shared/credentials'
import { fillScript, readScript } from '../shared/loginScripts'
import { resolveGuest } from './browse'
import { ensureCaps } from './controlElevation'
import { registerControlMethod } from './controlServer'
import { credentials } from './credentials'

export const LOGIN_WORLD_ID = 1026

function run<T>(guest: Electron.WebContents, code: string): Promise<T> {
  return guest.executeJavaScriptInIsolatedWorld(LOGIN_WORLD_ID, [{ code }]) as Promise<T>
}

export type FillResult =
  | { ok: true; username: string }
  | { ok: false; error: 'no-login' | 'no-form' | 'origin-changed' | 'locked' }

export async function fillFromStore(
  guest: Electron.WebContents,
  pick: (list: CredentialSummary[]) => CredentialSummary | undefined,
): Promise<FillResult> {
  const store = credentials()
  if (!store) return { ok: false, error: 'locked' }
  const origin = normalizeOrigin(guest.getURL())
  const matches = origin ? store.forOrigin(origin) : []
  const chosen = pick(matches)
  const entry = chosen ? matches.find((m) => m.id === chosen.id) : undefined
  if (!entry || !origin) return { ok: false, error: 'no-login' }
  if (normalizeOrigin(guest.getURL()) !== entry.origin)
    return { ok: false, error: 'origin-changed' }
  const res = await run<{ filled: boolean }>(guest, fillScript(entry.username, entry.password))
  return res?.filled ? { ok: true, username: entry.username } : { ok: false, error: 'no-form' }
}

export function registerLoginFill(deps: {
  browserPanes: Map<string, number>
  isSharedPane: (paneId: string) => boolean
  ownedGuest: (paneId: string, senderWindowId: string) => Electron.WebContents | null
}): void {
  ipcMain.handle('credentials:for-page', (e, paneId: unknown): CredentialSummary[] => {
    const guest = typeof paneId === 'string' ? deps.ownedGuest(paneId, String(e.sender.id)) : null
    const store = credentials()
    if (!guest || !store) return []
    return store.forOrigin(guest.getURL()).map(({ password: _p, ...summary }) => summary)
  })
  ipcMain.handle('credentials:fill', async (e, paneId: unknown, id: unknown) => {
    const guest = typeof paneId === 'string' ? deps.ownedGuest(paneId, String(e.sender.id)) : null
    if (!guest || typeof id !== 'string') return { ok: false, error: 'no-login' }
    return fillFromStore(guest, (list) => list.find((c) => c.id === id))
  })
  ipcMain.handle('credentials:save-from-page', async (e, paneId: unknown) => {
    const guest = typeof paneId === 'string' ? deps.ownedGuest(paneId, String(e.sender.id)) : null
    const store = credentials()
    if (!guest || !store) return { ok: false, error: 'empty' }
    const found = await run<{ username: string; password: string } | null>(guest, readScript())
    if (!found) return { ok: false, error: 'empty' }
    return store.save({
      origin: guest.getURL(),
      username: found.username,
      password: found.password,
    })
  })

  registerControlMethod('browse.login', {
    cap: 'browse',
    handler: async (params, ctx) => {
      const { paneId, username } = (params ?? {}) as { paneId?: unknown; username?: unknown }
      const resolution = await resolveGuest(
        deps,
        ctx,
        typeof paneId === 'string' ? paneId : undefined,
      )
      if (!resolution.ok) return resolution
      const origin = normalizeOrigin(resolution.guest.getURL()) ?? resolution.guest.getURL()
      if (!deps.isSharedPane(resolution.rendererPaneId)) {
        await ensureCaps(ctx.authed, ctx.identity, ['credentials'], 'browse login', origin)
      }
      const res = await fillFromStore(resolution.guest, (list) =>
        typeof username === 'string' ? list.find((c) => c.username === username) : list[0],
      )
      return res.ok ? { ok: true, origin, username: res.username } : res
    },
  })
}
