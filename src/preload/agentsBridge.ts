import { ipcRenderer } from 'electron'
import type { AgentSessionInfo } from '../shared/agents/agentSessionInfo'
import type { FolderTrust, ManagerOpenPaneRequest, ResumeVerdict } from '../shared/agents/agentsApi'
import type { MailMap } from '../shared/agents/mailApi'
import type { WorktreeShareMap } from '../shared/agents/worktreeShareApi'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const agentsBridge: Pick<
  OstiaBridge,
  'manager' | 'agentSession' | 'mail' | 'worktreeShare'
> = {
  manager: {
    onOpen: (cb) => {
      const handler = (_e: unknown, requestId: string, req: ManagerOpenPaneRequest): void =>
        ipcRenderer.send('manager:open-result', requestId, cb(req))
      ipcRenderer.on('manager:open', handler)
      ipcRenderer.send('manager:ready')
      return () => ipcRenderer.removeListener('manager:open', handler)
    },
  },
  worktreeShare: {
    snapshot: () => ipcRenderer.invoke('agents:worktree-snapshot') as Promise<WorktreeShareMap>,
    onChange: (cb) => listen('agents:worktree', cb),
  },
  mail: {
    snapshot: () => ipcRenderer.invoke('bus:mail-snapshot') as Promise<MailMap>,
    onChange: (cb) => listen('bus:mail', cb),
    dismiss: (paneId) => ipcRenderer.invoke('bus:mail-dismiss', paneId) as Promise<void>,
  },
  agentSession: {
    info: (resume) =>
      ipcRenderer.invoke('agent:session-info', resume) as Promise<AgentSessionInfo | null>,
    claimResume: (paneId, resume) =>
      ipcRenderer.invoke('agent:claim-resume', paneId, resume) as Promise<ResumeVerdict>,
    folderTrust: (paneId) =>
      ipcRenderer.invoke('agent:folder-trust', paneId) as Promise<FolderTrust>,
    trustFolder: (paneId, folder) =>
      ipcRenderer.invoke('agent:trust-folder', paneId, folder) as Promise<boolean>,
  },
}
