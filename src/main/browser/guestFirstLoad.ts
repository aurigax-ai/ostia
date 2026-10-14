type Listener = (details: unknown) => void

export interface FirstLoadGuest {
  isDestroyed(): boolean
  stop(): void
  loadURL(url: string): Promise<unknown>
  on(event: 'did-start-navigation', listener: Listener): unknown
  off(event: 'did-start-navigation', listener: Listener): unknown
}

function newDocumentUrl(details: unknown): string | null {
  const { url, isMainFrame, isSameDocument } = (details ?? {}) as {
    url?: unknown
    isMainFrame?: unknown
    isSameDocument?: unknown
  }
  return isMainFrame === true && isSameDocument !== true && typeof url === 'string' ? url : null
}

export function holdFirstLoad(
  guest: FirstLoadGuest,
  ready: Promise<unknown>,
  defer: (run: () => void) => void = setImmediate,
): void {
  const settled = ready.catch(() => {})
  let waiting = true
  const onFirst: Listener = (details) => {
    const url = newDocumentUrl(details)
    if (url === null) return
    guest.off('did-start-navigation', onFirst)
    if (!waiting) return
    defer(() => {
      if (guest.isDestroyed()) return
      guest.stop()
      let replaced = false
      const onNext: Listener = (next) => {
        if (newDocumentUrl(next) !== null) replaced = true
      }
      guest.on('did-start-navigation', onNext)
      void settled.then(() => {
        if (guest.isDestroyed()) return
        guest.off('did-start-navigation', onNext)
        if (!replaced) guest.loadURL(url).catch(() => {})
      })
    })
  }
  guest.on('did-start-navigation', onFirst)
  void settled.then(() => {
    waiting = false
  })
}
