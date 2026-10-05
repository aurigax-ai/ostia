export type BrowserAction = 'focusAddress' | 'reload' | 'back' | 'forward' | 'find'

export interface BrowserHandle {
  guestId: () => number | null
  focusAddress: () => void
  reload: () => void
  back: () => void
  forward: () => void
  find: () => void
}

const handles = new Map<string, BrowserHandle>()

export function registerBrowserHandle(paneId: string, handle: BrowserHandle): () => void {
  handles.set(paneId, handle)
  return () => {
    if (handles.get(paneId) === handle) handles.delete(paneId)
  }
}

export function browserHandleFor(paneId: string): BrowserHandle | undefined {
  return handles.get(paneId)
}

export function browserPaneOfGuest(guestId: number): string | null {
  for (const [paneId, handle] of handles) if (handle.guestId() === guestId) return paneId
  return null
}

const CHORD_ACTIONS: Readonly<Record<string, BrowserAction>> = {
  'browser.focusAddress': 'focusAddress',
  'browser.reload': 'reload',
  'browser.back': 'back',
  'browser.forward': 'forward',
  'browser.find': 'find',
  find: 'find',
}

export function browserActionOf(chord: string): BrowserAction | null {
  return Object.hasOwn(CHORD_ACTIONS, chord) ? CHORD_ACTIONS[chord] : null
}

export function runBrowserAction(paneId: string, action: BrowserAction): boolean {
  const handle = handles.get(paneId)
  if (!handle) return false
  handle[action]()
  return true
}
