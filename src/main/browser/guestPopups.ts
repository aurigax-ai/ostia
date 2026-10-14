import type { BrowserWindow, BrowserWindowConstructorOptions, WebContents } from 'electron'

export const POPUP_GESTURE_MS = 5000

const GESTURE_INPUTS = new Set(['mouseDown', 'keyDown', 'touchStart'])

export interface GuestActivity {
  inputAt?: number
  agentAt?: number
}

export function humanGestureAllowsPopup(activity: GuestActivity | undefined, now: number): boolean {
  if (activity?.inputAt === undefined || now - activity.inputAt > POPUP_GESTURE_MS) return false
  return activity.agentAt === undefined || now - activity.agentAt > POPUP_GESTURE_MS
}

const activities = new Map<number, GuestActivity>()

function activityOf(guestId: number): GuestActivity {
  let activity = activities.get(guestId)
  if (!activity) {
    activity = {}
    activities.set(guestId, activity)
  }
  return activity
}

export function noteAgentDrive(guestId: number, now: number = Date.now()): void {
  activityOf(guestId).agentAt = now
}

export function forgetGuestPopups(guestId: number): void {
  activities.delete(guestId)
}

export function popupTitle(url: string, title: string): string {
  let host = ''
  try {
    host = new URL(url).host
  } catch {}
  if (!host) return title
  return title && title !== host ? `${host} · ${title}` : host
}

export function popupWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    autoHideMenuBar: true,
    webPreferences: {
      preload: undefined,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  }
}

export interface GuestPopupsDeps {
  isHumanProfile: (guest: WebContents) => boolean
  ownerWindow: (guest: WebContents) => BrowserWindow | null
  prepare: (popup: BrowserWindow, url: string) => void
  now?: () => number
}

export function openHumanPopups(guest: WebContents, deps: GuestPopupsDeps): void {
  const now = deps.now ?? Date.now
  const guestId = guest.id
  guest.on('input-event', (_event, input) => {
    if (GESTURE_INPUTS.has(input.type)) activityOf(guestId).inputAt = now()
  })
  guest.setWindowOpenHandler(() => {
    const parent = deps.ownerWindow(guest)
    if (!parent || !deps.isHumanProfile(guest)) return { action: 'deny' }
    if (!humanGestureAllowsPopup(activities.get(guestId), now())) return { action: 'deny' }
    activityOf(guestId).inputAt = undefined
    return { action: 'allow', overrideBrowserWindowOptions: popupWindowOptions(parent) }
  })
  guest.on('did-create-window', (popup, details) => {
    popup.removeMenu()
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    popup.setTitle(popupTitle(details.url, ''))
    popup.on('page-title-updated', (event, title) => {
      event.preventDefault()
      popup.setTitle(popupTitle(popup.webContents.getURL() || details.url, title))
    })
    deps.prepare(popup, details.url)
  })
  guest.once('destroyed', () => forgetGuestPopups(guestId))
}
