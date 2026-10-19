import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const permissionsBridge: Pick<OstiaBridge, 'scriptTokens' | 'approvals' | 'questions'> = {
  scriptTokens: {
    list: () => ipcRenderer.invoke('scriptTokens:list'),
    create: (input) => ipcRenderer.invoke('scriptTokens:create', input),
    update: (input) => ipcRenderer.invoke('scriptTokens:update', input),
    revoke: (id) => ipcRenderer.invoke('scriptTokens:revoke', id),
    usage: (id) => ipcRenderer.invoke('scriptTokens:usage', id),
    onChanged: (cb) => listen('scriptTokens:changed', () => cb()),
  },
  approvals: {
    state: () => ipcRenderer.invoke('approvals:state'),
    answer: (id, answer) => ipcRenderer.invoke('approvals:answer', id, answer),
    revoke: (id) => ipcRenderer.invoke('approvals:revoke', id),
    removeAlways: (cap) => ipcRenderer.invoke('approvals:remove-always', cap),
    setReach: (mode) => ipcRenderer.invoke('approvals:set-reach', mode),
    onChange: (cb) => listen('approvals:changed', cb),
    agentGroups: () => ipcRenderer.invoke('reach:agent-groups'),
    onAgentGroupsChanged: (cb) => listen('reach:agent-groups-changed', cb),
  },
  questions: {
    state: () => ipcRenderer.invoke('questions:state'),
    answer: (id, reply) => ipcRenderer.invoke('questions:answer', id, reply),
    dismiss: (id) => ipcRenderer.invoke('questions:dismiss', id),
    onChange: (cb) => listen('questions:changed', cb),
  },
}
