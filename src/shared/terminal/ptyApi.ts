export type HumanInputSource = 'key' | 'paste'

import type { RemoteCwd } from '@aurigax-ai/ostia-extension-sdk/contract/remoteFolders'
import type { HibernateOutcome } from '../agents/agentWork'
import type { FsEntry } from '../files/filesApi'
import type { SpecCommand } from './completionSpec'
import type { PromptSeparator } from './promptSettings'
import type {
  HistoryBlockRange,
  HistoryPage,
  HistorySearchOptions,
  HistorySearchResult,
} from './scrollbackHistory'

export type KeptLink = 'up' | 'reconnecting' | 'failed'

export interface PaneActivity {
  program: string | null
  agentRunning: boolean
}

export interface PtySpawnOptions {
  cwd?: string
  cols: number
  rows: number
  role?: 'owner' | 'observer'
  sinceCursor?: number
  ostiaPrompt?: OstiaPromptSpawn
  workspaceId?: string
  hostToken?: string
  attachOnly?: boolean
}

interface OstiaPromptSpawn {
  separator: PromptSeparator
  sameLine: boolean
}

export interface PromptContextRequest {
  node: boolean
  kube: boolean
}

export interface PromptContext {
  user: string
  host: string
  home: string
  virtualEnv: string | null
  condaEnv: string | null
  nodeVersion: string | null
  kubeContext: string | null
}

export interface PtyAttachResult {
  created: boolean
  buffer: string
  cursor: number
  dropped: boolean
  blockSeqBase?: number
  shell?: string
  sandboxed?: boolean
  sandboxStamp?: string
  host?: boolean
  cols?: number
  rows?: number
  held?: true
  kept?: boolean
  link?: Exclude<KeptLink, 'up'>
  reattached?: boolean
  agentRunning?: boolean
  cwdMissing?: boolean
  markNonce?: string
}

interface PtyApi {
  attach: (paneId: string, opts: PtySpawnOptions) => Promise<PtyAttachResult>
  detach: (paneId: string) => void
  hibernate: (paneId: string) => Promise<HibernateOutcome>
  historyRead: (paneId: string, from: number, count: number) => Promise<HistoryPage | null>
  historySearch: (
    paneId: string,
    query: string,
    options: HistorySearchOptions,
    liveLines: number,
  ) => Promise<HistorySearchResult | null>
  historyBlock: (paneId: string, seq: number, command: string) => Promise<HistoryBlockRange | null>
  blockOutput: (paneId: string, seq: number, command: string) => Promise<string | null>
  keptWaiting: () => Promise<string[]>
  restart: (paneId: string) => Promise<boolean>
  reportAgentRunning: (paneId: string, running: boolean) => void
  reportWaking: (paneId: string, waking: boolean, reason?: string) => void
  write: (paneId: string, data: string, source?: HumanInputSource) => void
  releaseHold: (paneId: string) => void
  retryLink: (paneId: string) => void
  ack: (paneId: string, chars: number) => void
  resize: (paneId: string, cols: number, rows: number) => void
  commands: (paneId: string) => Promise<string[]>
  foreground: (paneId: string) => Promise<string | null>
  activity: (paneId: string) => Promise<PaneActivity | null>
  promptContext: (paneId: string, want: PromptContextRequest) => Promise<PromptContext | null>
  onData: (paneId: string, cb: (data: string) => void) => () => void
  onExit: (paneId: string, cb: (exitCode: number, closes: boolean) => void) => () => void
  listDir: (paneId: string, dir: string) => Promise<FsEntry[]>
  history: (paneId: string) => Promise<ShellHistoryEntry[]>
  localPrompt: (paneId: string) => Promise<boolean>
  onLink: (paneId: string, cb: (link: KeptLink) => void) => () => void
  onSize: (paneId: string, cb: (cols: number, rows: number, held: boolean) => void) => () => void
  onRun: (cb: (paneId: string, command: string) => void) => () => void
}

export interface ShellHistoryEntry {
  command: string
  time: number | null
}

export interface TerminalStateSnapshot {
  paneId: string
  generation: number
  cwd?: string
  running: boolean
  blockCount: number
  lastExitCode?: number
  remote?: RemoteCwd
}

interface TerminalStateApi {
  push: (snapshot: TerminalStateSnapshot) => void
}

interface CompletionsApi {
  spec: (command: string) => Promise<SpecCommand | null>
}

export interface PtyBridge {
  pty: PtyApi
  terminalState: TerminalStateApi
  completions: CompletionsApi
}
