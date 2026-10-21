import type {
  GatewayBindAddress,
  GatewayDevice,
  GatewayPairRequest,
  GatewayRelayState,
  GatewayRemoteStatus,
  GatewayTailnetState,
} from '@shared/gateway/gatewayApi'
import { useCallback, useEffect, useRef, useState } from 'react'

export interface GatewayStatus {
  status: GatewayRemoteStatus | null
  tailnet: GatewayTailnetState
  relay: GatewayRelayState
  devices: GatewayDevice[]
  addresses: GatewayBindAddress[]
  requests: GatewayPairRequest[]
  setRequests: (requests: GatewayPairRequest[]) => void
  refresh: () => Promise<void>
}

export function useGatewayStatus(): GatewayStatus {
  const [status, setStatus] = useState<GatewayRemoteStatus | null>(null)
  const [tailnet, setTailnet] = useState<GatewayTailnetState>({ state: 'off' })
  const [relay, setRelay] = useState<GatewayRelayState>({ state: 'off' })
  const [devices, setDevices] = useState<GatewayDevice[]>([])
  const [addresses, setAddresses] = useState<GatewayBindAddress[]>([])
  const [requests, setRequests] = useState<GatewayPairRequest[]>([])
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const [nextStatus, { devices: list }] = await Promise.all([
      window.ostia.gateway.status(),
      window.ostia.gateway.devices(),
    ])
    if (!mounted.current) return
    setStatus(nextStatus)
    setTailnet(nextStatus.tailnet)
    setRelay(nextStatus.relay)
    setDevices(list)
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    void window.ostia.gateway.bindAddresses().then((next) => {
      if (mounted.current) setAddresses(next)
    })
    void window.ostia.gateway.pairRequests().then((next) => {
      if (mounted.current) setRequests(next)
    })
    const offRequests = window.ostia.gateway.onPairRequestsChanged((next) => {
      setRequests(next)
      void refresh()
    })
    const offTailnet = window.ostia.gateway.onTailnetChanged(setTailnet)
    const offRelay = window.ostia.gateway.onRelayChanged(setRelay)
    return () => {
      mounted.current = false
      offRequests()
      offTailnet()
      offRelay()
    }
  }, [refresh])

  return { status, tailnet, relay, devices, addresses, requests, setRequests, refresh }
}
