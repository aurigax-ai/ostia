import { ipcRenderer } from 'electron'
import type { DiscreteGpuInfo } from '../shared/app/discreteGpu'
import type { RequirementsReport } from '../shared/app/systemRequirements'
import type { ExtensionResult } from '../shared/extensions'
import type { OstiaBridge } from '../shared/types'

export const systemBridge: Pick<OstiaBridge, 'system'> = {
  system: {
    requirements: (feature) =>
      ipcRenderer.invoke('system:requirements', feature) as Promise<RequirementsReport | null>,
    installRequirements: (feature, workspaceId) =>
      ipcRenderer.invoke(
        'system:install-requirements',
        feature,
        workspaceId,
      ) as Promise<ExtensionResult>,
    discreteGpu: () => ipcRenderer.invoke('system:discrete-gpu') as Promise<DiscreteGpuInfo | null>,
  },
}
