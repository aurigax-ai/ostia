import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const assistBridge: Pick<OstiaBridge, 'assist' | 'chatSessions' | 'chatTools'> = {
  assist: {
    availability: () => ipcRenderer.invoke('assist:availability'),
    onAvailability: (cb) => listen('assist:availability', cb),
    request: (point, requestId, input, model) =>
      ipcRenderer.invoke('assist:request', point, requestId, input, model),
    cancel: (requestId) => ipcRenderer.send('assist:cancel', requestId),
    onChunk: (cb) => listen('assist:chunk', cb),
    overview: () => ipcRenderer.invoke('assist:overview'),
    onOverview: (cb) => listen('assist:overview', cb),
    onOpenUi: (cb) => listen('assist:open-ui', cb),
    reportShortcuts: (shortcuts) => ipcRenderer.send('assist:shortcuts', shortcuts),
    models: (extId, provider) => ipcRenderer.invoke('assist:models', extId, provider),
    setModelLoaded: (extId, id, loaded, provider) =>
      ipcRenderer.invoke('assist:set-model-loaded', extId, id, loaded, provider),
    catalog: () => ipcRenderer.invoke('assist:catalog'),
    onCatalog: (cb) => listen('assist:catalog', cb),
    setProviderKey: (providerId, value) =>
      ipcRenderer.invoke('assist:set-provider-key', providerId, value),
    wake: () => ipcRenderer.send('assist:wake'),
  },
  chatSessions: {
    list: () => ipcRenderer.invoke('chat:list'),
    get: (id) => ipcRenderer.invoke('chat:get', id),
    save: (session) => ipcRenderer.invoke('chat:save', session),
    rename: (id, title) => ipcRenderer.invoke('chat:rename', id, title),
    remove: (id) => ipcRenderer.invoke('chat:remove', id),
    exportMarkdown: (id) => ipcRenderer.invoke('chat:export', id),
    saveFile: (name, content) => ipcRenderer.invoke('chat:save-file', name, content),
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
    playbooks: () => ipcRenderer.invoke('chatTools:playbooks'),
    playbookPrompt: (name, task) => ipcRenderer.invoke('chatTools:playbook-prompt', name, task),
    mcpStatus: () => ipcRenderer.invoke('chatTools:mcp-status'),
    mcpRefresh: () => ipcRenderer.invoke('chatTools:mcp-refresh'),
    mcpReconnect: (server) => ipcRenderer.invoke('chatTools:mcp-reconnect', server),
    onMcpStatus: (cb) => listen('chatTools:mcp-status', cb),
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
    onAlwaysGrants: (cb) => listen('chatTools:always-grants', cb),
  },
}
