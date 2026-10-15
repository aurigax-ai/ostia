import type {
  AssistAvailability,
  AssistCatalog,
  AssistChunk,
  AssistExtensionState,
  AssistOpenUiRequest,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import { ipcRenderer } from 'electron'
import type {
  ChatExportResult,
  ChatSaveResult,
  ChatSession,
  ChatSessionSummary,
} from '../shared/assist/chatSessions'
import type { McpServerStatus } from '../shared/assist/chatTools'
import type { OstiaBridge } from '../shared/types'

export const assistBridge: Pick<OstiaBridge, 'assist' | 'chatSessions' | 'chatTools'> = {
  assist: {
    availability: () => ipcRenderer.invoke('assist:availability') as Promise<AssistAvailability>,
    onAvailability: (cb) => {
      const handler = (_e: unknown, availability: AssistAvailability): void => cb(availability)
      ipcRenderer.on('assist:availability', handler)
      return () => ipcRenderer.removeListener('assist:availability', handler)
    },
    request: (point, requestId, input, model) =>
      ipcRenderer.invoke('assist:request', point, requestId, input, model),
    cancel: (requestId) => ipcRenderer.send('assist:cancel', requestId),
    onChunk: (cb) => {
      const handler = (_e: unknown, chunk: AssistChunk): void => cb(chunk)
      ipcRenderer.on('assist:chunk', handler)
      return () => ipcRenderer.removeListener('assist:chunk', handler)
    },
    overview: () => ipcRenderer.invoke('assist:overview') as Promise<AssistExtensionState[]>,
    onOverview: (cb) => {
      const handler = (_e: unknown, overview: AssistExtensionState[]): void => cb(overview)
      ipcRenderer.on('assist:overview', handler)
      return () => ipcRenderer.removeListener('assist:overview', handler)
    },
    onOpenUi: (cb) => {
      const handler = (_e: unknown, req: AssistOpenUiRequest): void => cb(req)
      ipcRenderer.on('assist:open-ui', handler)
      return () => ipcRenderer.removeListener('assist:open-ui', handler)
    },
    reportShortcuts: (shortcuts) => ipcRenderer.send('assist:shortcuts', shortcuts),
    models: (extId, provider) => ipcRenderer.invoke('assist:models', extId, provider),
    setModelLoaded: (extId, id, loaded, provider) =>
      ipcRenderer.invoke('assist:set-model-loaded', extId, id, loaded, provider),
    catalog: () => ipcRenderer.invoke('assist:catalog') as Promise<AssistCatalog>,
    onCatalog: (cb) => {
      const handler = (_e: unknown, catalog: AssistCatalog): void => cb(catalog)
      ipcRenderer.on('assist:catalog', handler)
      return () => ipcRenderer.removeListener('assist:catalog', handler)
    },
    setProviderKey: (providerId, value) =>
      ipcRenderer.invoke('assist:set-provider-key', providerId, value),
    wake: () => ipcRenderer.send('assist:wake'),
  },
  chatSessions: {
    list: () => ipcRenderer.invoke('chat:list') as Promise<ChatSessionSummary[]>,
    get: (id) => ipcRenderer.invoke('chat:get', id) as Promise<ChatSession | null>,
    save: (session) => ipcRenderer.invoke('chat:save', session) as Promise<ChatSaveResult>,
    rename: (id, title) =>
      ipcRenderer.invoke('chat:rename', id, title) as Promise<ChatSessionSummary | null>,
    remove: (id) => ipcRenderer.invoke('chat:remove', id) as Promise<boolean>,
    exportMarkdown: (id) => ipcRenderer.invoke('chat:export', id) as Promise<ChatExportResult>,
    saveFile: (name, content) =>
      ipcRenderer.invoke('chat:save-file', name, content) as Promise<ChatExportResult>,
  },
  chatTools: {
    read: (req) => ipcRenderer.invoke('chatTools:read', req),
    list: (req) => ipcRenderer.invoke('chatTools:list', req),
    search: (req) => ipcRenderer.invoke('chatTools:search', req),
    preview: (req) => ipcRenderer.invoke('chatTools:preview', req),
    plan: (req) => ipcRenderer.invoke('chatTools:plan', req),
    write: (req) => ipcRenderer.invoke('chatTools:write', req),
    restore: (req) => ipcRenderer.invoke('chatTools:restore', req),
    skills: () => ipcRenderer.invoke('chatTools:skills'),
    loadSkill: (name) => ipcRenderer.invoke('chatTools:load-skill', name),
    mcpStatus: () => ipcRenderer.invoke('chatTools:mcp-status'),
    mcpRefresh: () => ipcRenderer.invoke('chatTools:mcp-refresh'),
    mcpReconnect: (server) => ipcRenderer.invoke('chatTools:mcp-reconnect', server),
    onMcpStatus: (cb) => {
      const handler = (_e: unknown, status: McpServerStatus[]): void => cb(status)
      ipcRenderer.on('chatTools:mcp-status', handler)
      return () => ipcRenderer.removeListener('chatTools:mcp-status', handler)
    },
    mcpCall: (callId, server, tool, input) =>
      ipcRenderer.invoke('chatTools:mcp-call', callId, server, tool, input),
    mcpCancel: (callId) => ipcRenderer.send('chatTools:mcp-cancel', callId),
    setMcpSecret: (server, key, value) =>
      ipcRenderer.invoke('chatTools:set-mcp-secret', server, key, value),
    mcpSignIn: (server) => ipcRenderer.invoke('chatTools:mcp-sign-in', server),
    mcpCancelSignIn: (server) => ipcRenderer.send('chatTools:mcp-cancel-sign-in', server),
    mcpSignOut: (server) => ipcRenderer.invoke('chatTools:mcp-sign-out', server),
    mcpTest: (server) => ipcRenderer.invoke('chatTools:mcp-test', server),
    alwaysGrants: () => ipcRenderer.invoke('chatTools:always-grants'),
    grantAlways: (key) => ipcRenderer.invoke('chatTools:grant-always', key),
    removeAlwaysGrant: (key) => ipcRenderer.invoke('chatTools:remove-always-grant', key),
    onAlwaysGrants: (cb) => {
      const handler = (_e: unknown, keys: string[]): void => cb(keys)
      ipcRenderer.on('chatTools:always-grants', handler)
      return () => ipcRenderer.removeListener('chatTools:always-grants', handler)
    },
  },
}
