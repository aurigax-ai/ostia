import { rmSync } from 'node:fs'
import { MANAGER_CAPABILITIES } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import { managerAgents } from '../../shared/agents/managerSettings'
import { setCaps } from '../approvals/capabilityStore'
import { getByPaneId, markManager } from '../control/idRegistry'
import { loadJson, saveJson } from '../platform/jsonStore'
import type { PtyIo } from '../terminal/pty/ptyIo'
import { ManagerService } from './manager'
import { type ManagerLimiter, registerManagerMethods } from './managerMethods'
import type { ManagerPanes } from './managerPanes'
import type { ManagerPty } from './managerPty'

interface ManagerStartDeps {
  registerManagerIpc: ManagerPanes['registerManagerIpc']
  services: {
    managerLimiter: ManagerLimiter | null
    managerService: ManagerService | null
  }
  managerSettings: () => ManagerSettings
  paneIo: PtyIo['paneIo']
  openWorker: ManagerPanes['openWorker']
  managerResumePath: () => string
  createManagerPane: ManagerPanes['createManagerPane']
  spawnManagerPty: ManagerPty['spawnManagerPty']
  startPortal: ManagerPanes['startPortal']
}

export function startManager({
  registerManagerIpc,
  services,
  managerSettings,
  paneIo,
  openWorker,
  managerResumePath,
  createManagerPane,
  spawnManagerPty,
  startPortal,
}: ManagerStartDeps) {
  registerManagerIpc()
  services.managerLimiter = registerManagerMethods({
    settings: managerSettings,
    agents: () => managerAgents(managerSettings()),
    io: paneIo,
    openWorker,
    paneAlive: (paneId) => getByPaneId(paneId) !== undefined,
    now: Date.now,
  })
  services.managerService = new ManagerService({
    loadResume: () => loadJson<unknown>(managerResumePath(), null),
    saveResume: (saved) => {
      if (saved) saveJson(managerResumePath(), saved)
      else rmSync(managerResumePath(), { force: true })
    },
    agents: () => managerAgents(managerSettings()),
    createPane: createManagerPane,
    adopt: (paneId) => {
      const identity = markManager(paneId)
      if (identity) setCaps(identity.externalId, MANAGER_CAPABILITIES)
      return identity !== undefined
    },
    spawn: spawnManagerPty,
  })
  startPortal()
}
