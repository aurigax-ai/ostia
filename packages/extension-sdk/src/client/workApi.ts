import type { ConnectionInfo, ConnectionValue } from '../contract/extensionConnections'
import { errorMessage } from './results'
export interface ExecOptions {
  workspaceId: string
  command: string[]
  timeoutMs: number
  maxOutputBytes?: number
  dataDir?: string
  env?: Record<string, string>
}

export type ExecResult =
  | {
      ok: true
      exitCode: number
      signal?: string
      timedOut: boolean
      stdout: string
      stderr: string
      truncated: boolean
      sandboxed: boolean
    }
  | { ok: false; error: string; message?: string }

export type BusSendResult =
  | {
      ok: true
      id: string
      state: 'queued' | 'delivered'
      pending?:
        | 'working'
        | 'idle-no-wake'
        | 'idle-will-wake'
        | 'draft'
        | 'rate-limited'
        | 'hibernated'
        | 'hooks-off'
        | 'no-agent'
    }
  | { ok: false; error: string; message?: string }

export type CallerCapsResult = { ok: true } | { ok: false; error: string; message?: string }

export type WakePaneOutcome = 'woke' | 'started' | 'timedOut' | 'closed' | 'resume-failed'

export type WakePaneResult =
  | { ok: true; outcome: WakePaneOutcome }
  | { ok: false; error: string; message?: string }

export interface AskOptions {
  workspaceId: string
  question: string
  context?: string
  choices?: string[]
  mode?: 'text' | 'single' | 'multi'
  timeoutS?: number
}

export type AskResult =
  | { ok: true; outcome: 'answered'; reply: { choices: string[]; text: string } }
  | { ok: true; outcome: 'dismissed' | 'timeout' | 'closed' }
  | { ok: false; error: string; message?: string }

export interface AgentCompleteOptions {
  system: string
  input: string
}

export type AgentCompleteResult =
  | { ok: true; text: string }
  | { ok: false; error: string; message?: string }

export interface ParkedItem {
  id: string
  workspaceId: string
  agent: 'claude' | 'codex'
  sessionId: string
  title: string
  summary?: string
  folder?: string
  parkedAt: number
}

export type ParkedListResult =
  | { ok: true; items: ParkedItem[] }
  | { ok: false; error: string; message?: string }

export type ParkedActResult = { ok: true } | { ok: false; error: string; message?: string }

export type McpCallReply =
  | { ok: true; text: string; structured?: Record<string, unknown> }
  | { ok: false; error: string; message?: string }

export interface McpServerInfo {
  name: string
  state: 'idle' | 'connecting' | 'ready' | 'error'
  tools: string[]
}

export type McpServersResult =
  | { ok: true; servers: McpServerInfo[] }
  | { ok: false; error: string; message?: string }

export type ConnectionsResult =
  | { ok: true; connections: ConnectionInfo[] }
  | { ok: false; error: string; message?: string }

export type ConnectionResult =
  | { ok: true; connection: ConnectionValue | null }
  | { ok: false; error: string; message?: string }

export function rpcFailure(
  err: unknown,
  fallback: string,
): { ok: false; error: string; message: string } {
  const message = errorMessage(err)
  const code = /^([a-z][a-z0-9-]{0,40}):/.exec(message)?.[1]
  return { ok: false, error: code ?? fallback, message }
}
