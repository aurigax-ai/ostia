import type { ServerSyncStatus } from '@shared/profileSync/serverSync'
import { useEffect, useState } from 'react'

const POLL_MS = 4000

const SYNC_SERVER_OFF: ServerSyncStatus = {
  state: 'signed-out',
  host: null,
  linking: false,
  linkApproved: false,
  linkCodes: [],
  joins: [],
  recoveryStale: false,
  wrapRefused: null,
  changedDevices: [],
}

export function useSyncServerStatus(
  active = true,
): [ServerSyncStatus, (s: ServerSyncStatus) => void] {
  const [status, setStatus] = useState<ServerSyncStatus>(SYNC_SERVER_OFF)
  useEffect(() => {
    if (!active) return
    let live = true
    const load = (): void => {
      void window.ostia.syncServer.status().then((next) => {
        if (live) setStatus(next)
      })
    }
    load()
    const timer = setInterval(load, POLL_MS)
    const off = window.ostia.syncServer.onStatus((next) => setStatus(next))
    const offServer = window.ostia.server.onChanged(load)
    return () => {
      live = false
      clearInterval(timer)
      off()
      offServer()
    }
  }, [active])
  return [status, setStatus]
}
