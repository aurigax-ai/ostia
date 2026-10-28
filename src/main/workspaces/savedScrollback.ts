import { existsSync, rmSync } from 'node:fs'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { isDangerousSegment } from '@aurigax-ai/ostia-extension-sdk/contract/protoGuard'
import { MAX_PANES } from '../../shared/workspaces/workspaceLimits'
import { loadJson, saveJsonAsync, storePath } from '../platform/jsonStore'
import { tailCut } from '../terminal/ptyRingBuffer'
import { snapshotPath } from './workspaceSnapshot'

export const SCROLLBACK_CAP_BYTES = 131_072

export function scrollbackPath(): string {
  return storePath('scrollback', 'global')
}

export function trimScrollback(data: string, capBytes = SCROLLBACK_CAP_BYTES): string {
  return data.slice(tailCut(data, capBytes))
}

const restored = new Map<string, string>()

export function scrollbackToSave(
  byPane: Record<string, string>,
  unsaved: (paneId: string) => boolean = () => false,
): Record<string, string> {
  const out: Record<string, string> = {}
  let kept = 0
  for (const [paneId, data] of Object.entries(byPane)) {
    if (kept >= MAX_PANES) break
    if (!data || isDangerousSegment(paneId) || unsaved(paneId)) continue
    out[paneId] = trimScrollback(data)
    kept++
  }
  return out
}

let scrollbackEpoch = 0
let scrollbackWrites: Promise<void> = Promise.resolve()

export function saveScrollback(
  byPane: Record<string, string>,
  unsaved: (paneId: string) => boolean = () => false,
): Promise<void> {
  const epoch = scrollbackEpoch
  const data = scrollbackToSave(byPane, unsaved)
  const write = scrollbackWrites.then(() =>
    epoch === scrollbackEpoch ? saveJsonAsync(scrollbackPath(), data) : undefined,
  )
  scrollbackWrites = write.catch(() => undefined)
  return write
}

export type RestoreOutcome = 'ok' | 'none' | 'failed'

export function loadRestoredScrollback(): RestoreOutcome {
  restored.clear()
  if (!existsSync(scrollbackPath())) return 'none'
  const raw = loadJson<unknown>(scrollbackPath(), null)
  if (!isRecord(raw)) return 'failed'
  for (const [paneId, data] of Object.entries(raw)) {
    if (typeof data === 'string' && data && !isDangerousSegment(paneId)) restored.set(paneId, data)
  }
  return 'ok'
}

export function takeRestoredScrollback(paneId: string): string | null {
  const data = restored.get(paneId)
  if (data === undefined) return null
  restored.delete(paneId)
  return data
}

export function stashScrollback(paneId: string, data: string): void {
  if (!data || isDangerousSegment(paneId)) return
  restored.set(paneId, trimScrollback(data))
}

export function pendingRestoredScrollback(): Record<string, string> {
  return Object.fromEntries(restored)
}

export function dropRestoredScrollback(paneId: string): void {
  restored.delete(paneId)
}

export function clearPersisted(): Promise<void> {
  restored.clear()
  scrollbackEpoch++
  for (const path of [snapshotPath(), scrollbackPath()]) {
    rmSync(path, { force: true })
  }
  scrollbackWrites = scrollbackWrites.then(() => rmSync(scrollbackPath(), { force: true }))
  return scrollbackWrites
}
