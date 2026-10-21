import type { ServerSyncStatus, SyncAttention } from '../../../shared/profileSync/serverSync'
import type { ServerApprovalsResult, ServerDevicesResult } from '../../../shared/server/serverApi'

export interface SyncAttentionDeps {
  signedIn: () => boolean
  syncStatus: () => Promise<ServerSyncStatus>
  devices: () => Promise<ServerDevicesResult>
  approvals: () => Promise<ServerApprovalsResult>
  publish: (items: SyncAttention[]) => void
  notify: (item: SyncAttention) => void
}

export interface SyncAttentionWatch {
  scan: () => Promise<SyncAttention[]>
}

async function gather(deps: SyncAttentionDeps): Promise<SyncAttention[] | null> {
  const [status, devices, approvals] = await Promise.all([
    deps.syncStatus(),
    deps.devices(),
    deps.approvals(),
  ])
  if (status.state === 'unreachable' || !devices.ok || !approvals.ok) return null
  const items: SyncAttention[] = status.joins.map((join) => ({
    kind: 'join',
    id: `join:${join.deviceId}`,
    deviceId: join.deviceId,
    name: join.name,
    code: join.code,
    createdAt: join.createdAt,
  }))
  if (status.changedDevices.length > 0) {
    items.push({
      kind: 'changed',
      id: `changed:${[...status.changedDevices].sort().join(',')}`,
      names: status.changedDevices,
    })
  }
  for (const device of devices.devices) {
    if (!device.isNew || device.current) continue
    items.push({
      kind: 'new-device',
      id: `new-device:${device.id}`,
      deviceId: device.id,
      name: device.name,
      createdAt: device.createdAt,
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
  const announced = new Set<string>()
  let scanning: Promise<SyncAttention[]> | null = null

  const run = async (): Promise<SyncAttention[]> => {
    let next: SyncAttention[] = []
    if (deps.signedIn()) {
      try {
        const gathered = await gather(deps)
        if (!gathered) return current
        next = gathered
      } catch {
        return current
      }
    }
    const ids = new Set(next.map((item) => item.id))
    for (const id of announced) if (!ids.has(id)) announced.delete(id)
    for (const item of next) {
      if (announced.has(item.id)) continue
      announced.add(item.id)
      deps.notify(item)
    }
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
  }
}
