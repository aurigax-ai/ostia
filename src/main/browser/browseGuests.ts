import { webContents } from 'electron'
import { ensureCaps } from '../approvals/controlElevation'
import { getByPaneId, resolveExternal } from '../control/idRegistry'
import type { BrowseDeps, MethodCtx } from './browseMethod'
import { noteAgentDrive } from './guestPopups'

interface Route {
  pattern: string
  abort: boolean
  body?: string
}

const dialogPolicies = new Map<number, { policy: 'accept' | 'dismiss'; text: string | null }>()
const dialogInitAttached = new Set<number>()
const reactGrabOn = new Set<number>()
const mousePositions = new Map<number, { x: number; y: number }>()
const guestRoutes = new Map<number, Route[]>()
const activeTabs = new Map<string, string>()

export const browseState = {
  dialogPolicies,
  dialogInitAttached,
  reactGrabOn,
  mousePositions,
  guestRoutes,
  activeTabs,
}

export type BrowseState = typeof browseState

export function clearGuestBrowseState(wcId: number): void {
  dialogPolicies.delete(wcId)
  dialogInitAttached.delete(wcId)
  reactGrabOn.delete(wcId)
  mousePositions.delete(wcId)
  guestRoutes.delete(wcId)
}

type GuestResolution =
  | { ok: true; guest: Electron.WebContents; rendererPaneId: string }
  | { ok: false; error: 'no-browser-pane' }
  | { ok: false; error: 'browser-not-ready' }
  | { ok: false; error: 'needs-elevation' }

export function liveGuest(wcId: number | undefined): Electron.WebContents | null {
  if (wcId === undefined) return null
  const guest = webContents.fromId(wcId)
  return guest && !guest.isDestroyed() ? guest : null
}

export const SHARED_PROFILE_DETAIL =
  "act in the human's signed-in browser: this tab uses their own browser profile, with their cookies, logins and open sessions"

type GuestDeps = Pick<BrowseDeps, 'browserPanes' | 'isSharedPane' | 'reach'>

async function elevate(
  ctx: MethodCtx,
  cap: 'all-workspaces' | 'credentials',
  detail: string,
): Promise<GuestResolution | null> {
  try {
    await ensureCaps(ctx.authed, ctx.identity, [cap], 'browse', detail)
    return null
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('needs-elevation')) {
      return { ok: false, error: 'needs-elevation' }
    }
    throw e
  }
}

function sharedDetail(tabId: string): string {
  return `${SHARED_PROFILE_DETAIL} (tab ${tabId})`
}

export function defaultBrowserPane(deps: GuestDeps, ctx: MethodCtx): string | undefined {
  const active = activeTabs.get(ctx.identity.paneId)
  if (active && getByPaneId(active)?.workspaceId === ctx.identity.workspaceId) {
    if (liveGuest(deps.browserPanes.get(active))) return active
  }
  for (const [rendererPaneId, wcId] of deps.browserPanes) {
    if (getByPaneId(rendererPaneId)?.workspaceId !== ctx.identity.workspaceId) continue
    if (deps.isSharedPane(rendererPaneId)) continue
    if (liveGuest(wcId)) return rendererPaneId
  }
  return undefined
}

export async function resolveGuest(
  deps: GuestDeps,
  ctx: MethodCtx,
  paneId?: string,
): Promise<GuestResolution> {
  if (paneId) {
    const identity = resolveExternal(paneId)
    if (!identity) return { ok: false, error: 'no-browser-pane' }
    const wcId = deps.browserPanes.get(identity.paneId)
    if (wcId === undefined) return { ok: false, error: 'browser-not-ready' }
    if (!(await deps.reach.inScope(ctx, identity.workspaceId))) {
      const refused = await elevate(ctx, 'all-workspaces', `pane ${paneId}`)
      if (refused) return refused
    }
    if (deps.isSharedPane(identity.paneId)) {
      const refused = await elevate(ctx, 'credentials', sharedDetail(paneId))
      if (refused) return refused
    }
    const guest = liveGuest(wcId)
    if (!guest) return { ok: false, error: 'browser-not-ready' }
    noteAgentDrive(guest.id)
    return { ok: true, guest, rendererPaneId: identity.paneId }
  }
  const rendererPaneId = defaultBrowserPane(deps, ctx)
  const guest = rendererPaneId ? liveGuest(deps.browserPanes.get(rendererPaneId)) : null
  if (!rendererPaneId || !guest) return { ok: false, error: 'no-browser-pane' }
  if (deps.isSharedPane(rendererPaneId)) {
    const tabId = getByPaneId(rendererPaneId)?.externalId ?? rendererPaneId
    const refused = await elevate(ctx, 'credentials', sharedDetail(tabId))
    if (refused) return refused
  }
  noteAgentDrive(guest.id)
  return { ok: true, guest, rendererPaneId }
}

export function ownedGuest(
  browserPanes: Map<string, number>,
  paneId: string,
  senderWindowId: string,
): Electron.WebContents | null {
  if (typeof paneId !== 'string' || getByPaneId(paneId)?.windowId !== senderWindowId) return null
  return liveGuest(browserPanes.get(paneId))
}

export type CaptureGuestOf = (paneId: string, senderWindowId: string) => Electron.WebContents | null

export function captureGuestOf(
  browserPanes: Map<string, number>,
  previewGuestId: (senderWindowId: string, paneId: string) => number | null,
): CaptureGuestOf {
  return (paneId, senderWindowId) =>
    ownedGuest(browserPanes, paneId, senderWindowId) ??
    liveGuest(previewGuestId(senderWindowId, paneId) ?? undefined)
}
