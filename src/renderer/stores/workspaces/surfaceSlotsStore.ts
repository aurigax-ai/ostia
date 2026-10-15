import { TERMINAL_INPUT_SELECTOR } from '@/lib/terminal/ostiaTerminal'

const hosts = new Map<string, HTMLDivElement>()
let holder: HTMLDivElement | null = null

function parking(): HTMLDivElement {
  if (!holder) holder = document.createElement('div')
  return holder
}

export function surfaceHost(paneId: string): HTMLDivElement {
  let host = hosts.get(paneId)
  if (!host) {
    host = document.createElement('div')
    host.className = 'surface-host surface-enter'
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

const SURFACE_INPUTS = [
  '.input-editor:not([hidden]) textarea',
  TERMINAL_INPUT_SELECTOR,
  '.editor.modified .native-edit-context',
  '.native-edit-context',
  'textarea[name="message"]',
  'webview',
]

function focusTarget(paneId: string): HTMLElement | null {
  const host = hosts.get(paneId)
  if (!host) return null
  for (const selector of SURFACE_INPUTS) {
    const target = host.querySelector<HTMLElement>(selector)
    if (target) return target
  }
  return null
}

export function focusSurface(paneId: string): void {
  focusTarget(paneId)?.focus()
}

function canTakeFocus(target: HTMLElement): boolean {
  return (
    target.isConnected &&
    !target.closest('[inert], [data-hidden]') &&
    !document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')
  )
}

function tookFocus(paneId: string): boolean {
  const target = focusTarget(paneId)
  if (!target || !canTakeFocus(target)) return false
  target.focus()
  return document.activeElement === target
}

let stopWaiting: (() => void) | null = null

export function focusSurfaceWhenReady(paneId: string, wanted: () => boolean): void {
  stopWaiting?.()
  if (!wanted() || tookFocus(paneId)) return
  const observer = new MutationObserver(() => {
    if (!wanted() || tookFocus(paneId)) stop()
  })
  const stop = (): void => {
    observer.disconnect()
    window.removeEventListener('pointerdown', stop, true)
    if (stopWaiting === stop) stopWaiting = null
  }
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributeFilter: ['inert', 'data-hidden', 'hidden'],
  })
  window.addEventListener('pointerdown', stop, true)
  stopWaiting = stop
}

export function releaseSurfaces(live: ReadonlySet<string>): void {
  for (const [paneId, host] of hosts) {
    if (live.has(paneId)) continue
    host.remove()
    hosts.delete(paneId)
  }
}
