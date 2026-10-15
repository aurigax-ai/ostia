import { ipcRenderer } from 'electron'
import type {
  GatewayActionResult,
  GatewayBindAddress,
  GatewayDevice,
  GatewayEnableResponse,
  GatewayPairRequest,
  GatewayPairResponse,
  GatewayRemoteStatus,
  GatewaySetCapResult,
  GatewaySetRouteResult,
  GatewayTailnetActionResult,
  GatewayTailnetState,
  OstiaBridge,
} from '../shared/types'

export const gatewayBridge: Pick<OstiaBridge, 'gateway'> = {
  gateway: {
    enable: () => ipcRenderer.invoke('gateway:enable') as Promise<GatewayEnableResponse>,
    disable: () => ipcRenderer.invoke('gateway:disable') as Promise<GatewayRemoteStatus>,
    pair: () => ipcRenderer.invoke('gateway:pair') as Promise<GatewayPairResponse>,
    status: () => ipcRenderer.invoke('gateway:status') as Promise<GatewayRemoteStatus>,
    devices: () => ipcRenderer.invoke('gateway:devices') as Promise<{ devices: GatewayDevice[] }>,
    revoke: (deviceId) =>
      ipcRenderer.invoke('gateway:revoke', { deviceId }) as Promise<{
        ok: boolean
        error?: string
      }>,
    setCap: (deviceId, cap, granted) =>
      ipcRenderer.invoke('gateway:set-cap', {
        deviceId,
        cap,
        granted,
      }) as Promise<GatewaySetCapResult>,
    bindAddresses: () =>
      ipcRenderer.invoke('gateway:bind-addresses') as Promise<GatewayBindAddress[]>,
    setRoute: (route) =>
      ipcRenderer.invoke('gateway:set-route', route) as Promise<GatewaySetRouteResult>,
    tailnetSignIn: () =>
      ipcRenderer.invoke('gateway:tailnet-sign-in') as Promise<GatewayTailnetActionResult>,
    tailnetSignOut: () =>
      ipcRenderer.invoke('gateway:tailnet-sign-out') as Promise<GatewayTailnetActionResult>,
    onTailnetChanged: (cb) => {
      const handler = (_event: unknown, state: GatewayTailnetState): void => cb(state)
      ipcRenderer.on('gateway:tailnet-changed', handler)
      return () => ipcRenderer.removeListener('gateway:tailnet-changed', handler)
    },
    setDiscoverable: (on) =>
      ipcRenderer.invoke('gateway:set-discoverable', on) as Promise<GatewayActionResult>,
    pairRequests: () =>
      ipcRenderer.invoke('gateway:pair-requests') as Promise<GatewayPairRequest[]>,
    answerPairRequest: (requestId, approve) =>
      ipcRenderer.invoke('gateway:pair-answer', {
        requestId,
        approve,
      }) as Promise<GatewayActionResult>,
    onPairRequestsChanged: (cb) => {
      const handler = (_event: unknown, requests: GatewayPairRequest[]): void => cb(requests)
      ipcRenderer.on('gateway:pair-requests-changed', handler)
      return () => ipcRenderer.removeListener('gateway:pair-requests-changed', handler)
    },
  },
}
