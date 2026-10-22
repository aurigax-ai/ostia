import type { ServerDevice } from '@shared/server/serverApi'
import { useCallback, useEffect, useState } from 'react'

const POLL_MS = 8000

export interface ServerDevicesState {
  devices: ServerDevice[]
  loaded: boolean
  reload: () => void
}

export function useServerDevices(active = true): ServerDevicesState {
  const [devices, setDevices] = useState<ServerDevice[]>([])
  const [loaded, setLoaded] = useState(false)
  const reload = useCallback((): void => {
    void window.ostia.server.devices().then((res) => {
      if (res.ok) setDevices(res.devices)
      setLoaded(true)
    })
  }, [])
  useEffect(() => {
    if (!active) return
    reload()
    const timer = setInterval(reload, POLL_MS)
    const off = window.ostia.server.onDevicesChanged(reload)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [active, reload])
  return { devices, loaded, reload }
}
