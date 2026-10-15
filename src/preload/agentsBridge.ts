import { ipcRenderer } from 'electron'
import type { AgentSessionInfo } from '../shared/agents/agentSessionInfo'
import type { ManagerOpenPaneRequest, OstiaBridge, ResumeVerdict } from '../shared/types'

export const agentsBridge: Pick<OstiaBridge, 'manager' | 'agentSession'> = {
  manager: {
    onOpen: (cb) => {
      const handler = (_e: unknown, requestId: string, req: ManagerOpenPaneRequest): void =>
        ipcRenderer.send('manager:open-result', requestId, cb(req))
      ipcRenderer.on('manager:open', handler)
      ipcRenderer.send('manager:ready')
      return () => ipcRenderer.removeListener('manager:open', handler)
    },
  },
  agentSession: {
    info: (resume) =>
      ipcRenderer.invoke('agent:session-info', resume) as Promise<AgentSessionInfo | null>,
    claimResume: (paneId, resume) =>
      ipcRenderer.invoke('agent:claim-resume', paneId, resume) as Promise<ResumeVerdict>,
  },
}
