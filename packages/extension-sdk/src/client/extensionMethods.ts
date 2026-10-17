import { CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node'
import type { AssistProviderEntry } from '../contract/assist'
import { EXTENSION_BASE_LOCALE } from '../contract/extensionLocales'
import {
  type AgentOfferResult,
  type ExtensionResult,
  type ExtensionSettingValues,
  type SandboxDomainsResult,
  TARGET_PANE_PARAM,
} from '../contract/extensions'
import type { HostHandlers } from './hostHandlers'
import type { OpenFolderResult, OpenTerminalResult, OstiaExtension } from './index'
import { errorMessage, failure } from './results'
import {
  type AskResult,
  type BusSendResult,
  type ConnectionResult,
  type ConnectionsResult,
  type ExecResult,
  type McpCallReply,
  type McpServersResult,
  type WakePaneResult,
  rpcFailure,
} from './workApi'

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
> {
  return {
    setAttention: (paneId, state, message) =>
      conn.sendRequest('pane.setAttention', { [TARGET_PANE_PARAM]: paneId, state, message }),
    openDiff: (diff) => conn.sendRequest('ext.openDiff', diff),
    openFile: (file) => conn.sendRequest('ext.openFile', file),
    openTerminal: async (opts) => {
      try {
        return await conn.sendRequest<OpenTerminalResult>('ext.openTerminal', opts)
      } catch (err) {
        return { ok: false, error: 'open-terminal-failed', message: errorMessage(err) }
      }
    },
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
    runAgent: async (opts) => {
      try {
        return await conn.sendRequest<OpenTerminalResult>('ext.runAgent', opts)
      } catch (err) {
        return { ok: false, error: 'run-agent-failed', message: errorMessage(err) }
      }
    },
    offerToAgent: async (opts) => {
      try {
        return await conn.sendRequest<AgentOfferResult>('ext.offerToAgent', opts)
      } catch (err) {
        return { ok: false, error: 'offer-failed', message: errorMessage(err) }
      }
    },
    focusPane: async (paneId) => {
      try {
        return await conn.sendRequest<ExtensionResult>('ext.focusPane', { paneId })
      } catch (err) {
        return failure('focus-failed', errorMessage(err))
      }
    },
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
    exec: async (opts, signal) => {
      const source = new CancellationTokenSource()
      const cancel = (): void => source.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) source.cancel()
      try {
        return await conn.sendRequest<ExecResult>('ext.exec', opts, source.token)
      } catch (err) {
        return rpcFailure(err, 'exec-failed')
      } finally {
        signal?.removeEventListener('abort', cancel)
        source.dispose()
      }
    },
    busSend: async (to, text) => {
      try {
        return await conn.sendRequest<BusSendResult>('ext.busSend', { to, text })
      } catch (err) {
        return rpcFailure(err, 'bus-send-failed')
      }
    },
    wakePane: async (paneId, waitMs) => {
      try {
        return await conn.sendRequest<WakePaneResult>(
          'ext.wakePane',
          waitMs === undefined ? { paneId } : { paneId, waitMs },
        )
      } catch (err) {
        return rpcFailure(err, 'wake-failed')
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
  | 'sandboxDomains'
> {
  return {
    ask: async (opts, signal) => {
      const source = new CancellationTokenSource()
      const cancel = (): void => source.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) source.cancel()
      try {
        return await conn.sendRequest<AskResult>('ext.ask', opts, source.token)
      } catch (err) {
        return rpcFailure(err, 'ask-failed')
      } finally {
        signal?.removeEventListener('abort', cancel)
        source.dispose()
      }
    },
    mcpCall: async (server, tool, input, signal) => {
      const source = new CancellationTokenSource()
      const cancel = (): void => source.cancel()
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) source.cancel()
      try {
        return await conn.sendRequest<McpCallReply>(
          'ext.mcpCall',
          { server, tool, input },
          source.token,
        )
      } catch (err) {
        return rpcFailure(err, 'mcp-call-failed')
      } finally {
        signal?.removeEventListener('abort', cancel)
        source.dispose()
      }
    },
    mcpServers: async () => {
      try {
        return await conn.sendRequest<McpServersResult>('ext.mcpServers')
      } catch (err) {
        return rpcFailure(err, 'mcp-servers-failed')
      }
    },
    connections: async () => {
      try {
        return await conn.sendRequest<ConnectionsResult>('ext.connections')
      } catch (err) {
        return rpcFailure(err, 'connections-failed')
      }
    },
    connection: async (name) => {
      try {
        return await conn.sendRequest<ConnectionResult>('ext.connection', { name })
      } catch (err) {
        return rpcFailure(err, 'connection-failed')
      }
    },
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
    openFolder: async (opts) => {
      try {
        return await conn.sendRequest<OpenFolderResult>('ext.openFolder', opts)
      } catch (err) {
        return { ok: false, error: 'open-folder-failed', message: errorMessage(err) }
      }
    },
    closeFolder: async (folderId) => {
      try {
        return await conn.sendRequest<ExtensionResult>('ext.closeFolder', { folderId })
      } catch (err) {
        return failure('close-folder-failed', errorMessage(err))
      }
    },
    onFiles: (handler) => {
      handlers.files = handler
    },
    onFolderClosed: (handler) => {
      handlers.folderClosed = handler
    },
    sandboxDomains: async (workspaceId) => {
      try {
        return await conn.sendRequest<SandboxDomainsResult>('ext.sandboxDomains', { workspaceId })
      } catch (err) {
        return { ok: false, error: 'sandbox-domains-failed', message: errorMessage(err) }
      }
    },
  }
}
