const sockets = new Map<string, string>()

export function registerCodexSocket(externalId: string, path: string): void {
  sockets.set(externalId, path)
}

export function codexSocketOf(externalId: string): string | undefined {
  return sockets.get(externalId)
}

export function forgetCodexSocket(externalId: string): void {
  sockets.delete(externalId)
}
