import { rmSync } from 'node:fs'
import type { AgentResume } from '../../shared/agents/agentResume'
import { managerAgents } from '../../shared/agents/managerSettings'
import type { ManagerSettings } from '../../shared/agents/managerSettings'
import { getByPaneId } from '../control/idRegistry'
import type { PaneIo } from '../panes/paneIo'
import { loadJson, saveJson } from '../platform/jsonStore'
import { ManagerService } from './manager'
import { type ManagerLimiter, registerManagerMethods } from './managerMethods'

interface ManagerStartDeps {
  registerManagerIpc: () => void
  services: {
    managerLimiter: ManagerLimiter | null
    managerService: ManagerService | null
  }
  managerSettings: () => ManagerSettings
  paneIo: PaneIo
  openWorker: (req: {
    argv: string[]
    cwd?: string
    workspaceId?: string
    name?: string
  }) => Promise<string | null>
  managerResumePath: () => string
  createManagerPane: (req: { agent: string; cwd: string }) => Promise<string | null>
  spawnManagerPty: (req: {
    paneId: string
    argv: string[]
    cwd: string
    cols: number
    rows: number
    path?: string
    resume: AgentResume | null
    onExit: () => void
  }) => boolean
  startPortal: () => void
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
    spawn: spawnManagerPty,
  })
  startPortal()
}
