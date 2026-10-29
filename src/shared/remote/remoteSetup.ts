export const SETUP_STEPS = ['connect', 'tools', 'install', 'signin', 'check'] as const

export type SetupStepId = (typeof SETUP_STEPS)[number]

type SetupStepState = 'todo' | 'running' | 'waiting' | 'done' | 'failed'

export type RemoteError =
  | 'network'
  | 'auth'
  | 'host-key'
  | 'node-missing'
  | 'tmux-missing'
  | 'git-missing'
  | 'agent-missing'
  | 'incompatible'
  | 'runner-stopped'
  | 'install-failed'

export interface SetupStep {
  id: SetupStepId
  state: SetupStepState
  error?: RemoteError
  detail?: string
}

export type RemoteAgent = 'claude' | 'codex'

type JobState = 'working' | 'waiting' | 'idle' | 'exited'

export interface RemoteJob {
  pane: string
  agent: RemoteAgent | 'shell'
  folder: string
  state: JobState
  startedAt: string
}

export interface RemoteChoice {
  host: string
  folder: string
  agent: RemoteAgent
}
