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

export const REQUEST_TIMEOUT_MS = 30_000

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
  servingPanes: Map<string, number>
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

export function normalizeResult(raw: unknown): ExtensionResult {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    typeof (raw as { ok?: unknown }).ok === 'boolean'
  ) {
    const r = raw as {
      ok: boolean
      error?: unknown
      message?: unknown
      text?: unknown
      data?: unknown
    }
    if (!r.ok) {
      const failed = fail(
        typeof r.error === 'string' ? r.error : 'failed',
        typeof r.message === 'string' ? r.message : undefined,
      )
      return r.data === undefined ? failed : { ...failed, data: r.data }
    }
    const out: ExtensionResult = { ok: true }
    if (typeof r.text === 'string') out.text = r.text
    if (r.data !== undefined) out.data = r.data
    return out
  }
  return raw === undefined || raw === null ? { ok: true } : { ok: true, data: raw }
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
    servingPanes: new Map(),
  }
}
