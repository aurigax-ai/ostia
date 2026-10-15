import type { ChildProcess } from 'node:child_process'
import type {
  AssistFeatureId,
  AssistProviderKind,
  AssistProviderState,
  AssistSetupProblem,
  AssistStatus,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { LocaleCatalogs } from '@aurigax-ai/ostia-extension-sdk/contract/extensionLocales'
import type {
  ExtensionCommandContribution,
  ExtensionEventType,
  ExtensionResult,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { DiscoveredExtension } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc/node'
import type { PaneIdentity } from '../control/idRegistry'

type RunState = 'idle' | 'starting' | 'running' | 'crashed'

export interface LoadedExtension extends DiscoveredExtension {
  catalogs: LocaleCatalogs
}

export interface Runtime {
  ext: LoadedExtension
  proc: ChildProcess | null
  identity: PaneIdentity | null
  conn: MessageConnection | null
  ready: Map<string, ExtensionCommandContribution>
  subscriptions: Set<ExtensionEventType>
  state: RunState
  restarts: number
  restartTimer: ReturnType<typeof setTimeout> | null
  stopping: boolean
  restartAfterExit: boolean
  panelOrigins: Set<string>
  assistStatus: AssistStatus
  assistReport: AssistRuntimeReport | null
  offering: boolean
  reached: Set<string>
  opened: Set<string>
  callerWorkspaces: Set<string>
}

export interface AssistRuntimeReport {
  features: { id: AssistFeatureId; setting: string; ready: boolean }[]
  setup: AssistSetupProblem | null
  lastError?: string
  label?: string
  models: boolean
  providers?: AssistProviderState[]
  kinds: AssistProviderKind[]
}

export function cancelled(token: CancellationToken | undefined): Promise<'cancelled'> {
  return new Promise((resolve) => {
    if (!token) return
    if (token.isCancellationRequested) resolve('cancelled')
    else token.onCancellationRequested(() => resolve('cancelled'))
  })
}

export function fail(error: string, message?: string): ExtensionResult {
  return message ? { ok: false, error, message } : { ok: false, error }
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function newRuntime(ext: LoadedExtension): Runtime {
  return {
    ext,
    proc: null,
    identity: null,
    conn: null,
    ready: new Map(),
    subscriptions: new Set(),
    state: 'idle',
    restarts: 0,
    restartTimer: null,
    stopping: false,
    restartAfterExit: false,
    panelOrigins: new Set(),
    assistStatus: {},
    assistReport: null,
    offering: false,
    reached: new Set(),
    opened: new Set(),
    callerWorkspaces: new Set(),
  }
}
