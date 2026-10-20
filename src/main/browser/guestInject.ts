const injecting = new Set<number>()

export function isInjecting(guestId: number): boolean {
  return injecting.has(guestId)
}

export function injectInto<T>(guestId: number, send: () => T): T {
  const nested = injecting.has(guestId)
  injecting.add(guestId)
  try {
    return send()
  } finally {
    if (!nested) injecting.delete(guestId)
  }
}
