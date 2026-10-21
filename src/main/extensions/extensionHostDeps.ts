import type { AssistOpenUiRequest } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type {
  ExtensionResult,
  WorkspaceChip,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type {
  ExtensionAgentOffer,
  ExtensionOpenDiffRequest,
  ExtensionOpenFileRequest,
  ExtensionOpenPanelRequest,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { RemoteCwd } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { ExtensionRoot } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import type { RedactionResult } from '../../shared/privacy/redaction'
import type { AgentOfferDelivery, HeldResume } from '../agents/extensionAgents'
import type { PaneIdentity } from '../control/idRegistry'
import type { RemoteFolders, RemoteFoldersDeps } from '../files/remoteFolders'
import type { ExtensionConnections } from './extensionConnections'
import type { ExtensionExec } from './extensionExec'
import type { ExtensionLaunches } from './extensionLaunches'
import type { PhoneScreenLinks } from './extensionPhoneScreens'
import type { ExtensionConfirmRequest, TerminalOpenRequest } from './extensionRuns'
import type { ExtensionStore } from './extensionStore'

export interface ExtensionHostDeps {
  roots: ExtensionRoot[]
  store: ExtensionStore
  launches?: ExtensionLaunches
  socketPath: () => string
  nodePath: string
  dataDir?: string
  workDirForWorkspace: (workspaceId?: string) => string | undefined
  cwdForPane?: (paneId: string) => string | undefined
  locale?: () => string | undefined
  broadcast: (channel: string, payload: unknown) => void
  onChanged?: () => void
  onBrowseKindsChanged?: () => void
  publishWorkspaceChips?: (chips: WorkspaceChip[]) => void
  openPanelIn: (req: ExtensionOpenPanelRequest) => void
  openDiffIn?: (req: ExtensionOpenDiffRequest) => void
  openFileIn?: (req: ExtensionOpenFileRequest) => Promise<ExtensionResult>
  openTerminalIn?: (req: TerminalOpenRequest) => Promise<string | null>
  adoptPane?: (ownerPaneId: string, paneId: string) => void
  notify: (n: { title: string; body?: string; from: string }) => void
  restartDelayMs?: number
  readyTimeoutMs?: number
  requestTimeoutMs?: number
  interactiveTimeoutMs?: number
  log?: (extId: string, line: string) => void
  onCrashed?: (extId: string, builtin: boolean) => void
  readExtensionSettings?: () => unknown
  readAssistSettings?: () => { assistant?: unknown } | null
  assistKeys?: ExtensionSecretStore
  redact?: (text: string) => Promise<RedactionResult>
  assistTimeoutMs?: number
  openAssistUiIn?: (req: AssistOpenUiRequest) => void
  assistChatTimeoutMs?: number
  assistModelsTimeoutMs?: number
  secrets?: ExtensionSecretStore
  connections?: ExtensionConnections
  confirm?: (req: ExtensionConfirmRequest) => Promise<boolean>
  isSandboxed: (workspaceId: string) => boolean
  sandboxDomains: (workspaceId: string) => string[] | null
  hostGrants?: {
    offer: (extId: string, command: string) => void
    claim: (extId: string, command: string) => string | null
  }
  notifyPanel?: (
    n: { title: string; body?: string; from: string; extId: string; panelPath?: string },
    openPanel: () => void,
  ) => void
  agentArgv?: (name: string) => string[] | null
  agentNames?: () => string[]
  offerToAgentIn?: (offer: Omit<ExtensionAgentOffer, 'requestId'>) => Promise<AgentOfferDelivery>
  focusPaneIn?: (pane: PaneIdentity) => boolean
  exec?: ExtensionExec
  resumeOf?: (pane: PaneIdentity) => Promise<HeldResume | null>
  agentTaskClock?: () => number
  playbookEnabled?: (id: string) => boolean
  remoteCwdForPane?: (paneId: string) => RemoteCwd | undefined
  agentRunning?: (paneId: string) => boolean
  claimHumanPrompt?: (paneId: string, extId: string) => string | null
  screenLinks?: PhoneScreenLinks
  remoteFolders?: Pick<RemoteFoldersDeps, 'windowOfWorkspace' | 'refusal' | 'confirm'> & {
    publish: (folders: RemoteFolders) => void
  }
}

export interface ExtensionSecretStore {
  keys: (extId: string) => string[]
  get: (extId: string, key: string) => string | null
  set: (
    extId: string,
    key: string,
    value: string | null,
  ) => { ok: true } | { ok: false; error: string }
}
