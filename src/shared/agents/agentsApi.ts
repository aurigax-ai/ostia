import type { ClaudeAccountsBridge } from '../claudeAccounts/claudeAccountsApi'
import type { ParkBridge } from '../park/parkApi'
import type { AgentResume } from './agentResume'
import type { AgentSessionInfo } from './agentSessionInfo'
import type { MailApi } from './mailApi'

export interface ManagerOpenPaneRequest {
  agent: string
  cwd: string
  session: boolean
}

interface ManagerApi {
  onOpen: (
    cb: (req: ManagerOpenPaneRequest) => string | null | Promise<string | null>,
  ) => () => void
}

export type ResumeVerdict = { ok: true } | { ok: false; holder: string }

export type FolderTrust =
  | { state: 'trusted' }
  | { state: 'ask'; folder: string }
  | { state: 'unknown' }

interface AgentSessionApi {
  info: (resume: AgentResume) => Promise<AgentSessionInfo | null>
  claimResume: (paneId: string, resume: AgentResume) => Promise<ResumeVerdict>
  folderTrust: (paneId: string) => Promise<FolderTrust>
  trustFolder: (paneId: string, folder: string) => Promise<boolean>
  folderTrustDone: (paneId: string) => Promise<void>
  onFolderTrustAsk: (cb: (paneId: string, folder: string, inside: boolean) => void) => () => void
}

export interface AgentsBridge extends ParkBridge, ClaudeAccountsBridge {
  manager: ManagerApi
  agentSession: AgentSessionApi
  mail: MailApi
}
