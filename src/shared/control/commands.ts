import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'

export type JSONSchema = Record<string, unknown>

export type TargetMode = 'active' | 'explicit' | 'none'

type CommandErrorCode = 'unknown-command' | 'command-failed' | 'needs-elevation'

interface CommandError {
  code: CommandErrorCode
  message: string
}

export type CommandResult<R = unknown> =
  | { ok: true; result: R }
  | { ok: false; error: CommandError }

export interface CommandDescriptor {
  id: string
  title: string
  category: string | null
  hidden: boolean
  argsSchema: JSONSchema | null
  resultSchema: JSONSchema | null
  capabilities: Capability[]
  target: TargetMode
}

export interface CommandTarget {
  windowId?: string
  workspaceId: string
  paneId: string | null
}

export interface CommandInvokeRequest {
  id: string
  args?: unknown
  target: CommandTarget
  fromMain?: true
}

export interface CommandsApi {
  publish: (descriptors: CommandDescriptor[]) => void
  onInvoke: (handler: (req: CommandInvokeRequest) => Promise<CommandResult>) => () => void
}

export interface CommandsBridge {
  commands: CommandsApi
}
