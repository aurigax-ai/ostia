const lastActivity = new Map<string, number>()

export function markPaneActivity(paneId: string, at = Date.now()): void {
  lastActivity.set(paneId, at)
}

export function paneActivityAt(paneId: string): number | undefined {
  return lastActivity.get(paneId)
}

export function forgetPaneActivity(paneId: string): void {
  lastActivity.delete(paneId)
}
