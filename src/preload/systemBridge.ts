import { ipcRenderer } from 'electron'
import { SOFTWARE_WEBGL_ARG } from '../shared/app/discreteGpu'
import { NO_NEW_PRIVS_ARG } from '../shared/app/noNewPrivs'
import type { OstiaBridge } from '../shared/types'

export const systemBridge: Pick<OstiaBridge, 'system'> = {
  system: {
    requirements: (feature) => ipcRenderer.invoke('system:requirements', feature),
    installRequirements: (feature, workspaceId) =>
      ipcRenderer.invoke('system:install-requirements', feature, workspaceId),
    discreteGpu: () => ipcRenderer.invoke('system:discrete-gpu'),
    softwareWebgl: process.argv.includes(SOFTWARE_WEBGL_ARG),
    noNewPrivs: process.argv.includes(NO_NEW_PRIVS_ARG),
  },
}
