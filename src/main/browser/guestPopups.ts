import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  HandlerDetails,
  Referrer,
  WebContents,
} from 'electron'
import { isTabUrl } from '../../shared/browser/linkTabs'
import { clickedLinkOf } from './guestLinkClicks'

export const POPUP_GESTURE_MS = 5000

export const LINK_CLICK_MS = 1000

const GESTURE_INPUTS = new Set(['mouseDown', 'keyDown', 'touchStart'])

export interface GuestActivity {
  inputAt?: number
  agentAt?: number
  link?: { url: string; at: number }
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

function forgetGuestPopups(guestId: number): void {
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

function popupWindowOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
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

function clickedJustNow(activity: GuestActivity, url: string, now: number): boolean {
  const link = activity.link
  activity.link = undefined
  return link?.url === url && now - link.at <= LINK_CLICK_MS
}

function opensAsTab(details: HandlerDetails, activity: GuestActivity, now: number): boolean {
  if (details.postBody || !isTabUrl(details.url)) return false
  if (details.disposition === 'background-tab') return true
  if (details.disposition !== 'foreground-tab') return false
  const plain = details.frameName === '' && details.features === ''
  return clickedJustNow(activity, details.url, now) && plain
}

export interface GuestPopupsDeps {
  isHumanProfile: (guest: WebContents) => boolean
  ownerWindow: (guest: WebContents) => BrowserWindow | null
  prepare: (popup: BrowserWindow, url: string) => void
  openTab: (opener: WebContents, url: string, background: boolean, referrer: Referrer) => void
  now?: () => number
}

export function openHumanPopups(guest: WebContents, deps: GuestPopupsDeps): void {
  const now = deps.now ?? Date.now
  const guestId = guest.id
  guest.on('input-event', (_event, input) => {
    if (GESTURE_INPUTS.has(input.type)) activityOf(guestId).inputAt = now()
  })
  guest.on('console-message', ({ message }) => {
    const url = clickedLinkOf(message)
    if (url !== null) activityOf(guestId).link = { url, at: now() }
  })
  guest.setWindowOpenHandler((details) => {
    const parent = deps.ownerWindow(guest)
    if (!parent || !deps.isHumanProfile(guest)) return { action: 'deny' }
    if (!humanGestureAllowsPopup(activities.get(guestId), now())) return { action: 'deny' }
    const activity = activityOf(guestId)
    activity.inputAt = undefined
    if (opensAsTab(details, activity, now())) {
      const background = details.disposition === 'background-tab'
      deps.openTab(guest, details.url, background, details.referrer)
      return { action: 'deny' }
    }
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
