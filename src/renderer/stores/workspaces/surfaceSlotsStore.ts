const hosts = new Map<string, HTMLDivElement>()
let holder: HTMLDivElement | null = null

function parking(): HTMLDivElement {
  if (!holder) holder = document.createElement('div')
  return holder
}

export function surfaceHost(paneId: string, fadesIn = false): HTMLDivElement {
  let host = hosts.get(paneId)
  if (!host) {
    host = document.createElement('div')
    host.className = fadesIn ? 'surface-host surface-enter' : 'surface-host'
    host.addEventListener('animationend', (e) => {
      if (e.target === host) host.classList.remove('surface-enter')
    })
    host.dataset.paneId = paneId
    host.style.position = 'absolute'
    host.style.inset = '0'
    parking().appendChild(host)
    hosts.set(paneId, host)
  }
  return host
}

export function mountSurface(paneId: string, slot: HTMLElement): void {
  const host = surfaceHost(paneId)
  if (host.parentNode !== slot) slot.appendChild(host)
}

export function parkSurface(paneId: string, slot: HTMLElement): void {
  const host = hosts.get(paneId)
  if (host && host.parentNode === slot) parking().appendChild(host)
}

type FocusTarget = () => HTMLElement | null

interface FocusEntry {
  target: FocusTarget | null
}

const focusEntries = new Map<string, FocusEntry>()
let recheck: (() => void) | null = null

export function setFocusTarget(paneId: string, target: FocusTarget | null): () => void {
  const entry: FocusEntry = { target }
  focusEntries.set(paneId, entry)
  retryPendingFocus()
  return () => {
    if (focusEntries.get(paneId) === entry) focusEntries.delete(paneId)
  }
}

export function retryPendingFocus(): void {
  recheck?.()
}

function focusTarget(paneId: string): HTMLElement | null {
  return focusEntries.get(paneId)?.target?.() ?? null
}

function takesNoKeyboard(paneId: string): boolean {
  const entry = focusEntries.get(paneId)
  return entry !== undefined && entry.target === null
}

export function surfaceHoldsKeyboard(paneId: string): boolean {
  const active = document.activeElement
  return Boolean(active && hosts.get(paneId)?.contains(active))
}

export function focusSurface(paneId: string): void {
  focusTarget(paneId)?.focus()
}

const DIALOG = '[role="dialog"], [role="alertdialog"]'

function canTakeFocus(target: HTMLElement): boolean {
  return (
    target.isConnected &&
    !target.closest('[inert], [data-hidden]') &&
    !document.activeElement?.closest(DIALOG)
  )
}

function settled(paneId: string): boolean {
  if (takesNoKeyboard(paneId)) return true
  const target = focusTarget(paneId)
  if (!target || !canTakeFocus(target)) return false
  target.focus()
  return document.activeElement === target
}

let stopWaiting: (() => void) | null = null

export function focusSurfaceWhenReady(paneId: string, wanted: () => boolean): void {
  stopWaiting?.()
  if (!wanted() || settled(paneId)) return
  const check = (): void => {
    if (!wanted() || settled(paneId)) stop()
  }
  const observer = new MutationObserver(check)
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isTrusted) stop()
  }
  const onFocusIn = (e: FocusEvent): void => {
    const into = e.target
    if (into instanceof Element && (into === focusTarget(paneId) || into.closest(DIALOG))) return
    stop()
  }
  const stop = (): void => {
    observer.disconnect()
    window.removeEventListener('pointerdown', stop, true)
    window.removeEventListener('keydown', onKeyDown, true)
    window.removeEventListener('focusin', onFocusIn, true)
    if (stopWaiting === stop) {
      stopWaiting = null
      recheck = null
    }
  }
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributeFilter: ['inert', 'data-hidden', 'hidden'],
  })
  window.addEventListener('pointerdown', stop, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('focusin', onFocusIn, true)
  stopWaiting = stop
  recheck = check
}

export function releaseSurfaces(live: ReadonlySet<string>): void {
  for (const [paneId, host] of hosts) {
    if (live.has(paneId)) continue
    host.remove()
    hosts.delete(paneId)
  }
}
