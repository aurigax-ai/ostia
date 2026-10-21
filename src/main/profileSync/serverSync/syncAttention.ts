import type { ServerSyncStatus, SyncAttention } from '../../../shared/profileSync/serverSync'
import type { ServerApprovalsResult } from '../../../shared/server/serverApi'

export interface SyncAttentionDeps {
  active: () => boolean
  announced: { load: () => string[]; save: (ids: string[]) => void }
  syncStatus: () => Promise<ServerSyncStatus>
  approvals: () => Promise<ServerApprovalsResult>
  publish: (items: SyncAttention[]) => void
  notify: (item: SyncAttention) => void
}

export interface SyncAttentionWatch {
  scan: () => Promise<SyncAttention[]>
  delay: () => number
}

export const PENDING_SCAN_MS = 8_000
export const IDLE_SCAN_MS = 60_000
export const MAX_SCAN_MS = 15 * 60_000

async function gather(deps: SyncAttentionDeps): Promise<SyncAttention[] | null> {
  const [status, approvals] = await Promise.all([deps.syncStatus(), deps.approvals()])
  if (status.state === 'unreachable' || !approvals.ok) return null
  const items: SyncAttention[] = status.joins.map((join) => ({
    kind: 'join',
    id: `join:${join.deviceId}`,
    deviceId: join.deviceId,
    name: join.name,
    code: join.code,
    createdAt: join.createdAt,
  }))
  for (const device of status.changedDevices) {
    items.push({
      kind: 'changed',
      id: `changed:${device.id}:${device.until}`,
      deviceId: device.id,
      name: device.name,
      until: device.until,
    })
  }
  for (const approval of approvals.approvals) {
    items.push({
      kind: 'approval',
      id: `approval:${approval.id}`,
      approvalId: approval.id,
      deviceId: approval.deviceId,
      name: approval.deviceName,
      createdAt: approval.createdAt,
    })
  }
  return items
}

export function createSyncAttention(deps: SyncAttentionDeps): SyncAttentionWatch {
  let current: SyncAttention[] = []
  let announced: Set<string> | null = null
  let failures = 0
  let scanning: Promise<SyncAttention[]> | null = null

  const run = async (): Promise<SyncAttention[]> => {
    announced ??= new Set(deps.announced.load())
    let next: SyncAttention[] = []
    if (deps.active()) {
      try {
        const gathered = await gather(deps)
        if (!gathered) {
          failures += 1
          return current
        }
        next = gathered
        failures = 0
      } catch {
        failures += 1
        return current
      }
    } else {
      failures = 0
    }
    const ids = new Set(next.map((item) => item.id))
    const before = announced.size
    for (const id of announced) if (!ids.has(id)) announced.delete(id)
    let changed = announced.size !== before
    for (const item of next) {
      if (announced.has(item.id)) continue
      announced.add(item.id)
      changed = true
      deps.notify(item)
    }
    if (changed) deps.announced.save([...announced])
    if (JSON.stringify(next) !== JSON.stringify(current)) {
      current = next
      deps.publish(next)
    }
    return current
  }

  return {
    scan: () => {
      scanning ??= run().finally(() => {
        scanning = null
      })
      return scanning
    },
    delay: () => {
      if (failures > 0) return Math.min(IDLE_SCAN_MS * 2 ** (failures - 1), MAX_SCAN_MS)
      return current.length > 0 ? PENDING_SCAN_MS : IDLE_SCAN_MS
    },
  }
}
