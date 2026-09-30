import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'

export type HostRequest =
  | { id: number; type: 'init'; config: SandboxRuntimeConfig }
  | {
      id: number
      type: 'wrap'
      command: string
      binShell: string
      customConfig?: Partial<SandboxRuntimeConfig>
    }
  | { id: number; type: 'update'; config: SandboxRuntimeConfig }
  | { id: number; type: 'cleanup' }

export type HostResponse =
  | { id: number; ok: true; wrapped?: string }
  | { id: number; ok: false; error: string; missing?: string[] }

export type HostAsk = { type: 'ask'; askId: number; host: string; port?: number }

export type HostAskAnswer = { type: 'ask-answer'; askId: number; allow: boolean }

export type HostToMain = HostResponse | HostAsk

export type MainToHost = HostRequest | HostAskAnswer
