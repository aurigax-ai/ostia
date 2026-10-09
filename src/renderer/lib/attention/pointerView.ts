export const POINTER_VIEW_MS = 10_000

let pointed: { paneId: string; at: number } | null = null

export function pointAtPane(paneId: string, at: number): void {
  pointed = { paneId, at }
}

export function leavePane(paneId: string): void {
  if (pointed?.paneId === paneId) pointed = null
}

export function isPanePointedAt(paneId: string, now: number): boolean {
  return pointed?.paneId === paneId && now - pointed.at <= POINTER_VIEW_MS
}

export function resetPointerView(): void {
  pointed = null
}
