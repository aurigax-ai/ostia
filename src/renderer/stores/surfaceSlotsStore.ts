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

export function focusSurface(paneId: string): void {
  const host = hosts.get(paneId)
  const target =
    host?.querySelector<HTMLElement>('.input-editor:not([hidden]) textarea') ??
    host?.querySelector<HTMLElement>('.xterm-helper-textarea')
  target?.focus()
}

export function releaseSurfaces(live: ReadonlySet<string>): void {
  for (const [paneId, host] of hosts) {
    if (live.has(paneId)) continue
    host.remove()
    hosts.delete(paneId)
  }
}
