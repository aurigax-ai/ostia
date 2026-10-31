import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const sandboxBridge: Pick<OstiaBridge, 'secrets' | 'sandbox'> = {
  secrets: {
    view: (workspaceId) => ipcRenderer.invoke('secrets:view', workspaceId),
    setGrants: (workspaceId, grants) =>
      ipcRenderer.invoke('secrets:set-grants', workspaceId, grants),
    vaultSet: (workspaceId, key, value) =>
      ipcRenderer.invoke('secrets:vault-set', workspaceId, key, value),
    vaultDelete: (workspaceId, key) => ipcRenderer.invoke('secrets:vault-delete', workspaceId, key),
  },
  sandbox: {
    onLeftBehind: (cb) => listen('sandbox:left-behind', cb),
    onBlocked: (cb) => listen('sandbox:blocked', cb),
    get: (workspaceId) => ipcRenderer.invoke('sandbox:get', workspaceId),
    setPaths: (workspaceId, kind, paths) =>
      ipcRenderer.invoke('sandbox:set-paths', workspaceId, kind, paths),
    checkPaths: (kind, paths) => ipcRenderer.invoke('sandbox:check-paths', kind, paths),
    presets: () => ipcRenderer.invoke('sandbox:presets'),
    setDomains: (workspaceId, domains) =>
      ipcRenderer.invoke('sandbox:set-domains', workspaceId, domains),
    setDeniedDomains: (workspaceId, domains) =>
      ipcRenderer.invoke('sandbox:set-denied-domains', workspaceId, domains),
    setSwitches: (workspaceId, switches) =>
      ipcRenderer.invoke('sandbox:set-switches', workspaceId, switches),
    fixedPolicy: (workspaceId) => ipcRenderer.invoke('sandbox:fixed-policy', workspaceId),
    stamp: (workspaceId) => ipcRenderer.invoke('sandbox:stamp', workspaceId),
    violations: (workspaceId) => ipcRenderer.invoke('sandbox:violations', workspaceId),
    clearViolations: (workspaceId) => ipcRenderer.invoke('sandbox:clear-violations', workspaceId),
    setControls: (workspaceId, controls) =>
      ipcRenderer.invoke('sandbox:set-controls', workspaceId, controls),
    allowRefused: (workspaceId, host) =>
      ipcRenderer.invoke('sandbox:allow-refused', workspaceId, host),
    globalsChanged: () => ipcRenderer.invoke('sandbox:globals-changed'),
    setPackages: (workspaceId, packages) =>
      ipcRenderer.invoke('sandbox:set-packages', workspaceId, packages),
    ports: (workspaceId) => ipcRenderer.invoke('sandbox:ports', workspaceId),
    expose: (workspaceId, port) => ipcRenderer.invoke('sandbox:expose', workspaceId, port),
    unexpose: (workspaceId, port) => ipcRenderer.invoke('sandbox:unexpose', workspaceId, port),
    setPortsPolicy: (workspaceId, policy) =>
      ipcRenderer.invoke('sandbox:set-ports-policy', workspaceId, policy),
    setEnabled: (workspaceId, enabled) =>
      ipcRenderer.invoke('sandbox:set-enabled', workspaceId, enabled),
  },
}
