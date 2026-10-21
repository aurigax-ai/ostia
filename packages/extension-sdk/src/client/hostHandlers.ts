import type { CancellationToken, MessageConnection } from 'vscode-jsonrpc/node'
import type { AgentRequest } from '../contract/agent'
import type { AssistError, AssistPoint, AssistProviderEntry } from '../contract/assist'
import { CONNECTIONS_CHANGED_EVENT } from '../contract/extensionConnections'
import {
  type ExtensionLocaleChangedPayload,
  LOCALE_CHANGED_EVENT,
} from '../contract/extensionLocales'
import type {
  ExtensionCaller,
  ExtensionEventType,
  ExtensionSettingValues,
} from '../contract/extensions'
import {
  ASSIST_PROVIDERS_CHANGED_EVENT,
  INBOX_ACTION_EVENT,
  type InboxActionEvent,
  SETTINGS_CHANGED_EVENT,
} from '../contract/extensions'
import { FOLDER_CLOSED_EVENT, type RemoteFilesRequest } from '../contract/remoteFolders'
import { type BrowseProvider, listenForBrowse } from './browse'
import type {
  AgentHandler,
  AssistHandler,
  AssistModelsHandler,
  AssistProvidersHandler,
  CommandHandler,
  EventHandler,
  FilesHandler,
  FolderClosedHandler,
  LocaleHandler,
  PanelHandler,
  SettingsHandler,
} from './index'
import { errorMessage, failure } from './results'

export interface HostHandlers {
  commands: Map<string, CommandHandler>
  panel: PanelHandler | null
  event: EventHandler | null
  settings: SettingsHandler | null
  connections: (() => void) | null
  locale: LocaleHandler | null
  agent: AgentHandler | null
  assist: AssistHandler | null
  providers: AssistProvidersHandler | null
  models: AssistModelsHandler | null
  files: FilesHandler | null
  folderClosed: FolderClosedHandler | null
  inboxAction: ((event: InboxActionEvent) => void) | null
  browse: Map<string, BrowseProvider>
}

export function createHostHandlers(): HostHandlers {
  return {
    commands: new Map<string, CommandHandler>(),
    panel: null,
    event: null,
    settings: null,
    connections: null,
    locale: null,
    agent: null,
    assist: null,
    providers: null,
    models: null,
    files: null,
    folderClosed: null,
    inboxAction: null,
    browse: new Map<string, BrowseProvider>(),
  }
}

export class AssistFailure extends Error {
  constructor(
    readonly code: AssistError,
    message?: string,
  ) {
    super(message ?? code)
  }
}

export function assistFailureReply(
  err: unknown,
  aborted: boolean,
): { error: AssistError; message?: string } {
  if (aborted) return { error: 'cancelled' }
  if (err instanceof AssistFailure) return { error: err.code, message: err.message }
  return { error: 'failed', message: errorMessage(err) }
}

export function listenToHost(conn: MessageConnection, handlers: HostHandlers): void {
  conn.onRequest(
    'ext.command',
    async (params: { command: string; args: unknown; caller: ExtensionCaller }) => {
      const handler = handlers.commands.get(params.command)
      if (!handler) return failure('unknown-command', params.command)
      try {
        return await handler(params.args, params.caller)
      } catch (err) {
        return failure('command-failed', errorMessage(err))
      }
    },
  )
  conn.onRequest('ext.agent', async (params: AgentRequest) => {
    if (!handlers.agent) return { ok: false, error: 'unavailable' }
    try {
      return await handlers.agent(params)
    } catch (err) {
      return { ok: false, error: 'failed', message: errorMessage(err) }
    }
  })
  conn.onRequest(
    'ext.assist',
    async (
      params: {
        point: AssistPoint
        requestId: string
        input: never
        model?: { provider: string; model: string }
      },
      token: CancellationToken,
    ) => {
      if (!handlers.assist) throw new Error('no assist handler')
      const abort = new AbortController()
      const sub = token.onCancellationRequested(() => abort.abort())
      if (token.isCancellationRequested) abort.abort()
      try {
        return await handlers.assist(params.point, params.input, {
          requestId: params.requestId,
          signal: abort.signal,
          ...(params.model ? { model: params.model } : {}),
          chunk: async (text) => {
            if (abort.signal.aborted) return false
            const res = await conn.sendRequest<{ live?: unknown }>('ext.assistChunk', {
              requestId: params.requestId,
              text,
            })
            return res?.live === true
          },
        })
      } catch (err) {
        return assistFailureReply(err, abort.signal.aborted)
      } finally {
        sub.dispose()
      }
    },
  )
  conn.onRequest(
    'ext.assistModels',
    async (params: { action?: unknown; id?: unknown; provider?: unknown }) => {
      if (!handlers.models) throw new Error('no models handler')
      const provider = typeof params.provider === 'string' ? params.provider : undefined
      if (params.action === 'list') return handlers.models.list(provider)
      if (
        (params.action !== 'load' && params.action !== 'unload') ||
        typeof params.id !== 'string'
      ) {
        return { ok: false, error: 'invalid' }
      }
      try {
        await handlers.models.setLoaded(params.id, params.action === 'load', provider)
        return { ok: true }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )
  conn.onRequest('ext.files', async (params: RemoteFilesRequest) => {
    if (!handlers.files) return { ok: false, error: 'unavailable' }
    try {
      return await handlers.files(params)
    } catch {
      return { ok: false, error: 'failed' }
    }
  })
  listenForBrowse(conn, handlers.browse)
  conn.onRequest('ext.panel', async (params: { caller: ExtensionCaller; path?: string }) => {
    if (!handlers.panel) throw new Error('no panel handler')
    return handlers.panel(params.caller, params.path)
  })
  conn.onNotification(
    'ext.event',
    (params: {
      type:
        | ExtensionEventType
        | typeof SETTINGS_CHANGED_EVENT
        | typeof LOCALE_CHANGED_EVENT
        | typeof ASSIST_PROVIDERS_CHANGED_EVENT
        | typeof FOLDER_CLOSED_EVENT
        | typeof INBOX_ACTION_EVENT
        | typeof CONNECTIONS_CHANGED_EVENT
      payload: never
    }) => {
      if (params.type === SETTINGS_CHANGED_EVENT) {
        handlers.settings?.((params.payload as { values: ExtensionSettingValues }).values)
      } else if (params.type === ASSIST_PROVIDERS_CHANGED_EVENT) {
        handlers.providers?.((params.payload as { providers: AssistProviderEntry[] }).providers)
      } else if (params.type === LOCALE_CHANGED_EVENT) {
        handlers.locale?.((params.payload as ExtensionLocaleChangedPayload).locale)
      } else if (params.type === CONNECTIONS_CHANGED_EVENT) {
        handlers.connections?.()
      } else if (params.type === INBOX_ACTION_EVENT) {
        handlers.inboxAction?.(params.payload as InboxActionEvent)
      } else if (params.type === FOLDER_CLOSED_EVENT) {
        handlers.folderClosed?.((params.payload as { folderId: string }).folderId)
      } else {
        handlers.event?.(params.type, params.payload)
      }
    },
  )
}
