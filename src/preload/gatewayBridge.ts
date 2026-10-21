import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const gatewayBridge: Pick<OstiaBridge, 'gateway'> = {
  gateway: {
    enable: () => ipcRenderer.invoke('gateway:enable'),
    disable: () => ipcRenderer.invoke('gateway:disable'),
    pair: () => ipcRenderer.invoke('gateway:pair'),
    status: () => ipcRenderer.invoke('gateway:status'),
    devices: () => ipcRenderer.invoke('gateway:devices'),
    revoke: (deviceId) => ipcRenderer.invoke('gateway:revoke', { deviceId }),
    setCap: (deviceId, cap, granted) =>
      ipcRenderer.invoke('gateway:set-cap', {
        deviceId,
        cap,
        granted,
      }),
    setDevicePush: (deviceId, enabled) =>
      ipcRenderer.invoke('gateway:set-device-push', { deviceId, enabled }),
    onPushChanged: (cb) => listen('gateway:push-changed', cb),
    bindAddresses: () => ipcRenderer.invoke('gateway:bind-addresses'),
    setRoute: (route) => ipcRenderer.invoke('gateway:set-route', route),
    tailnetSignIn: () => ipcRenderer.invoke('gateway:tailnet-sign-in'),
    tailnetSignOut: () => ipcRenderer.invoke('gateway:tailnet-sign-out'),
    onTailnetChanged: (cb) => listen('gateway:tailnet-changed', cb),
    onRelayChanged: (cb) => listen('gateway:relay-changed', cb),
    setDiscoverable: (on) => ipcRenderer.invoke('gateway:set-discoverable', on),
    pairRequests: () => ipcRenderer.invoke('gateway:pair-requests'),
    answerPairRequest: (requestId, approve) =>
      ipcRenderer.invoke('gateway:pair-answer', {
        requestId,
        approve,
      }),
    onPairRequestsChanged: (cb) => listen('gateway:pair-requests-changed', cb),
    phoneWorkspace: () => ipcRenderer.invoke('gateway:phone-workspace'),
    setPhoneWorkspace: (save) => ipcRenderer.invoke('gateway:set-phone-workspace', save),
  },
}
