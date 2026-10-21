import {
  type CancellationToken,
  CancellationTokenSource,
  type MessageConnection,
} from 'vscode-jsonrpc/node'
import type { AgentToolReply } from '../contract/agent'
import { readEnv } from '../contract/appEnv'
import type { AssistProviderEntry } from '../contract/assist'
import { EXTENSION_BASE_LOCALE } from '../contract/extensionLocales'
import {
  type AgentOfferResult,
  type ExtensionResult,
  type ExtensionSettingValues,
  type SandboxDomainsResult,
  TARGET_PANE_PARAM,
} from '../contract/extensions'
import { type BrowseProvider, declaresBrowseKind } from './browse'
import type { HostHandlers } from './hostHandlers'
import type { OpenFolderResult, OpenTerminalResult, OstiaExtension } from './index'
import { errorMessage, failure } from './results'
import {
  type AgentCompleteResult,
  type AskResult,
  type BusSendResult,
  type CallerCapsResult,
  type ConnectionResult,
  type ConnectionsResult,
  type ExecResult,
  type McpCallReply,
  type McpServersResult,
  type ParkedActResult,
  type ParkedListResult,
  rpcFailure,
  type WakePaneResult,
} from './workApi'

type Failed = { ok: false; error: string; message?: string }

async function sent<T>(work: Promise<T>, error: string): Promise<T | Failed> {
  try {
    return await work
  } catch (err) {
    return failure(error, errorMessage(err)) as Failed
  }
}

async function sentRpc<T>(
  work: Promise<T>,
  fallback: string,
): Promise<T | ReturnType<typeof rpcFailure>> {
  try {
    return await work
  } catch (err) {
    return rpcFailure(err, fallback)
  }
}

async function withCancel<T>(
  signal: AbortSignal | undefined,
  work: (token: CancellationToken) => Promise<T>,
): Promise<T> {
  const source = new CancellationTokenSource()
  const cancel = (): void => source.cancel()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) source.cancel()
  try {
    return await work(source.token)
  } finally {
    signal?.removeEventListener('abort', cancel)
    source.dispose()
  }
}

export function windowMethods(
  conn: MessageConnection,
  handlers: HostHandlers,
): Pick<
  OstiaExtension,
  | 'call'
  | 'confirm'
  | 'notifyPanel'
  | 'registerCommands'
  | 'onPanel'
  | 'subscribe'
  | 'setSidebarItem'
  | 'startWithWindow'
  | 'wireRuntime'
  | 'notify'
  | 'openPanel'
  | 'setPanelToolbar'
  | 'setInboxItems'
  | 'onInboxAction'
  | 'setPaneChip'
  | 'clearPaneChip'
  | 'setWorkspaceChip'
  | 'clearWorkspaceChip'
  | 'getSettings'
  | 'setSetting'
  | 'onSettingsChanged'
  | 'getLocale'
  | 'onLocaleChanged'
  | 'callAs'
> {
  return {
    call: <T>(method: string, params?: unknown) =>
      params === undefined
        ? conn.sendRequest<T>(method)
        : conn.sendRequest<T>(method, params as object),
    confirm: async (req) => {
      const res = await conn.sendRequest<{ confirmed?: unknown }>('ext.confirm', req)
      return res?.confirmed === true
    },
    notifyPanel: (title, body, path) =>
      conn.sendRequest('ext.notify', { title, body, openPanel: path ?? true }),
    registerCommands: async (map) => {
      for (const [id, handler] of Object.entries(map)) handlers.commands.set(id, handler)
      await conn.sendRequest('ext.registerCommands', { commands: Object.keys(map) })
    },
    onPanel: (handler) => {
      handlers.panel = handler
    },
    subscribe: (events, handler) => {
      handlers.event = handler
      return conn.sendRequest('ext.subscribe', { events })
    },
    setSidebarItem: (item) => conn.sendRequest('ext.setSidebarItem', item),
    startWithWindow: (on) => conn.sendRequest('ext.startWithWindow', { on }),
    wireRuntime: () => conn.sendRequest('ext.wireRuntime', {}),
    notify: (title, body) => conn.sendRequest('ext.notify', { title, body }),
    openPanel: (workspaceId, path) => conn.sendRequest('ext.openPanel', { workspaceId, path }),
    setPanelToolbar: (toolbar) => conn.sendRequest('ext.setPanelToolbar', toolbar),
    setInboxItems: (workspaceId, items) =>
      conn.sendRequest('ext.setInboxItems', { workspaceId, items }),
    onInboxAction: (handler) => {
      handlers.inboxAction = handler
    },
    setPaneChip: (chip) => conn.sendRequest('ext.setPaneChip', chip),
    clearPaneChip: (paneId, id) => conn.sendRequest('ext.clearPaneChip', { paneId, id }),
    setWorkspaceChip: (chip) => conn.sendRequest('ext.setWorkspaceChip', chip),
    clearWorkspaceChip: (workspaceId, id) =>
      conn.sendRequest('ext.clearWorkspaceChip', { workspaceId, id }),
    getSettings: async () => {
      const res = await conn.sendRequest<{ values?: ExtensionSettingValues }>('ext.getSettings')
      return res?.values ?? {}
    },
    setSetting: (key, value) => conn.sendRequest('ext.setSetting', { key, value }),
    onSettingsChanged: (handler) => {
      handlers.settings = handler
    },
    getLocale: async () => {
      const res = await conn.sendRequest<{ locale?: unknown }>('ext.locale')
      return typeof res?.locale === 'string' ? res.locale : EXTENSION_BASE_LOCALE
    },
    onLocaleChanged: (handler) => {
      handlers.locale = handler
    },
    callAs: <T>(paneId: string, method: string, params?: object) =>
      conn.sendRequest<T>(method, { ...params, [TARGET_PANE_PARAM]: paneId }),
  }
}

export function agentMethods(
  conn: MessageConnection,
): Pick<
  OstiaExtension,
  | 'setAttention'
  | 'openDiff'
  | 'openFile'
  | 'openTerminal'
  | 'listAgents'
  | 'runAgent'
  | 'offerToAgent'
  | 'focusPane'
  | 'redact'
  | 'exec'
  | 'busSend'
  | 'wakePane'
  | 'requireCallerCaps'
  | 'playbookEnabled'
> {
  return {
    setAttention: (paneId, state, message) =>
      conn.sendRequest('pane.setAttention', { [TARGET_PANE_PARAM]: paneId, state, message }),
    openDiff: (diff) => conn.sendRequest('ext.openDiff', diff),
    openFile: (file) => conn.sendRequest('ext.openFile', file),
    openTerminal: (opts) =>
      sent(conn.sendRequest<OpenTerminalResult>('ext.openTerminal', opts), 'open-terminal-failed'),
    listAgents: async () => {
      try {
        const res = await conn.sendRequest<{ agents?: unknown }>('ext.agents')
        return Array.isArray(res?.agents)
          ? res.agents.filter((a): a is string => typeof a === 'string')
          : []
      } catch {
        return []
      }
    },
    runAgent: (opts) =>
      sent(conn.sendRequest<OpenTerminalResult>('ext.runAgent', opts), 'run-agent-failed'),
    offerToAgent: (opts) =>
      sent(conn.sendRequest<AgentOfferResult>('ext.offerToAgent', opts), 'offer-failed'),
    focusPane: (paneId) =>
      sent(conn.sendRequest<ExtensionResult>('ext.focusPane', { paneId }), 'focus-failed'),
    redact: async (texts) => {
      try {
        const res = await conn.sendRequest<{ ok?: unknown; texts?: unknown }>('ext.redact', {
          texts,
        })
        const redacted = res?.ok === true && Array.isArray(res.texts) ? res.texts : null
        return redacted?.length === texts.length &&
          redacted.every((t): t is string => typeof t === 'string')
          ? redacted
          : null
      } catch {
        return null
      }
    },
    exec: (opts, signal) =>
      withCancel(signal, (token) =>
        sentRpc(conn.sendRequest<ExecResult>('ext.exec', opts, token), 'exec-failed'),
      ),
    busSend: (to, text) =>
      sentRpc(conn.sendRequest<BusSendResult>('ext.busSend', { to, text }), 'bus-send-failed'),
    wakePane: (paneId, waitMs) =>
      sentRpc(
        conn.sendRequest<WakePaneResult>(
          'ext.wakePane',
          waitMs === undefined ? { paneId } : { paneId, waitMs },
        ),
        'wake-failed',
      ),
    requireCallerCaps: (paneId, caps, reason) =>
      sentRpc(
        conn.sendRequest<CallerCapsResult>('ext.requireCallerCaps', { paneId, caps, reason }),
        'caller-caps-failed',
      ),
    playbookEnabled: async () => {
      try {
        const res = await conn.sendRequest<{ enabled?: unknown }>('ext.playbookEnabled')
        return res?.enabled === true
      } catch {
        return false
      }
    },
  }
}

export function serviceMethods(
  conn: MessageConnection,
  handlers: HostHandlers,
): Pick<
  OstiaExtension,
  | 'ask'
  | 'mcpCall'
  | 'mcpServers'
  | 'onAgent'
  | 'agentEvent'
  | 'agentTool'
  | 'agentComplete'
  | 'parkedList'
  | 'parkedResume'
  | 'parkedForget'
  | 'connections'
  | 'connection'
  | 'onConnectionsChanged'
  | 'listWorkspaces'
  | 'listPanes'
  | 'onAssist'
  | 'onAssistModels'
  | 'setAssistStatus'
  | 'getShortcuts'
  | 'openAssistUi'
  | 'getSecret'
  | 'getAssistProviders'
  | 'onAssistProvidersChanged'
  | 'openFolder'
  | 'closeFolder'
  | 'onFiles'
  | 'onFolderClosed'
  | 'onBrowse'
  | 'sandboxDomains'
> {
  return {
    ask: (opts, signal) =>
      withCancel(signal, (token) =>
        sentRpc(conn.sendRequest<AskResult>('ext.ask', opts, token), 'ask-failed'),
      ),
    mcpCall: (server, tool, input, signal) =>
      withCancel(signal, (token) =>
        sentRpc(
          conn.sendRequest<McpCallReply>('ext.mcpCall', { server, tool, input }, token),
          'mcp-call-failed',
        ),
      ),
    onAgent: (handler) => {
      handlers.agent = handler
    },
    agentEvent: async (sessionId, event) => {
      await conn.sendRequest('ext.agentEvent', { sessionId, event })
    },
    agentTool: (call, signal) =>
      withCancel(signal, (token) =>
        conn
          .sendRequest<AgentToolReply>('ext.agentTool', call, token)
          .catch((err): AgentToolReply => ({ ok: false, error: errorMessage(err) })),
      ),
    agentComplete: (opts, signal) =>
      withCancel(signal, (token) =>
        sentRpc(
          conn.sendRequest<AgentCompleteResult>('ext.agentComplete', opts, token),
          'agent-complete-failed',
        ),
      ),
    parkedList: (workspaceId) =>
      sentRpc(
        conn.sendRequest<ParkedListResult>('ext.parkedList', { workspaceId }),
        'parked-failed',
      ),
    parkedResume: (id) =>
      sentRpc(conn.sendRequest<ParkedActResult>('ext.parkedResume', { id }), 'parked-failed'),
    parkedForget: (id) =>
      sentRpc(conn.sendRequest<ParkedActResult>('ext.parkedForget', { id }), 'parked-failed'),
    mcpServers: () =>
      sentRpc(conn.sendRequest<McpServersResult>('ext.mcpServers'), 'mcp-servers-failed'),
    connections: () =>
      sentRpc(conn.sendRequest<ConnectionsResult>('ext.connections'), 'connections-failed'),
    connection: (name) =>
      sentRpc(conn.sendRequest<ConnectionResult>('ext.connection', { name }), 'connection-failed'),
    onConnectionsChanged: (handler) => {
      handlers.connections = handler
    },
    listWorkspaces: () => conn.sendRequest('workspace.list'),
    listPanes: () => conn.sendRequest('pane.list'),
    onAssist: (handler) => {
      handlers.assist = handler
    },
    onAssistModels: (handler) => {
      handlers.models = handler
    },
    setAssistStatus: (report) => conn.sendRequest('ext.setAssistStatus', report),
    getShortcuts: async (ids) => {
      const res = await conn.sendRequest<{ shortcuts?: Record<string, string | null> }>(
        'ext.shortcuts',
        { ids },
      )
      return res?.shortcuts ?? {}
    },
    openAssistUi: (ui, workspaceId) =>
      conn.sendRequest('ext.openAssistUi', workspaceId ? { ui, workspaceId } : { ui }),
    getSecret: async (key) => {
      const res = await conn.sendRequest<{ value?: unknown }>('ext.getSecret', { key })
      return typeof res?.value === 'string' ? res.value : null
    },
    getAssistProviders: async () => {
      const res = await conn.sendRequest<{ providers?: AssistProviderEntry[] }>(
        'ext.assistProviders',
      )
      return Array.isArray(res?.providers) ? res.providers : []
    },
    onAssistProvidersChanged: (handler) => {
      handlers.providers = handler
    },
    openFolder: (opts) =>
      sent(conn.sendRequest<OpenFolderResult>('ext.openFolder', opts), 'open-folder-failed'),
    closeFolder: (folderId) =>
      sent(
        conn.sendRequest<ExtensionResult>('ext.closeFolder', { folderId }),
        'close-folder-failed',
      ),
    onFiles: (handler) => {
      handlers.files = handler
    },
    onFolderClosed: (handler) => {
      handlers.folderClosed = handler
    },
    onBrowse: (name: string, provider: BrowseProvider) => {
      const id = `${readEnv('EXTENSION_ID') ?? ''}.${name}`
      if (!declaresBrowseKind(readEnv('EXTENSION_DIR') ?? '', id)) {
        throw new Error(`${id} is not a browse kind in this extension's manifest`)
      }
      handlers.browse.set(id, provider)
      void conn.sendRequest('ext.registerCommands', { commands: [] }).catch(() => {})
    },
    sandboxDomains: (workspaceId) =>
      sent(
        conn.sendRequest<SandboxDomainsResult>('ext.sandboxDomains', { workspaceId }),
        'sandbox-domains-failed',
      ),
  }
}
