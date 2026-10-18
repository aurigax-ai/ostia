import { ipcRenderer } from 'electron'
import type { QuestionState } from '../shared/agents/questions'
import type { ApprovalState } from '../shared/permissions/approvals'
import type { AgentGroupPlacement } from '../shared/permissions/reach'
import type {
  ScriptTokenSaveResult,
  ScriptTokenUsage,
  ScriptTokensState,
} from '../shared/permissions/scriptTokens'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const permissionsBridge: Pick<OstiaBridge, 'scriptTokens' | 'approvals' | 'questions'> = {
  scriptTokens: {
    list: () => ipcRenderer.invoke('scriptTokens:list') as Promise<ScriptTokensState>,
    create: (input) =>
      ipcRenderer.invoke('scriptTokens:create', input) as Promise<ScriptTokenSaveResult>,
    update: (input) =>
      ipcRenderer.invoke('scriptTokens:update', input) as Promise<ScriptTokenSaveResult>,
    revoke: (id) => ipcRenderer.invoke('scriptTokens:revoke', id) as Promise<boolean>,
    usage: (id) => ipcRenderer.invoke('scriptTokens:usage', id) as Promise<ScriptTokenUsage | null>,
    onChanged: (cb) => listen('scriptTokens:changed', () => cb()),
  },
  approvals: {
    state: () => ipcRenderer.invoke('approvals:state') as Promise<ApprovalState>,
    answer: (id, answer) => ipcRenderer.invoke('approvals:answer', id, answer) as Promise<boolean>,
    revoke: (id) => ipcRenderer.invoke('approvals:revoke', id) as Promise<boolean>,
    removeAlways: (cap) => ipcRenderer.invoke('approvals:remove-always', cap) as Promise<boolean>,
    setReach: (mode) => ipcRenderer.invoke('approvals:set-reach', mode) as Promise<boolean>,
    onChange: (cb) => listen('approvals:changed', cb),
    agentGroups: () => ipcRenderer.invoke('reach:agent-groups') as Promise<AgentGroupPlacement[]>,
    onAgentGroupsChanged: (cb) => listen('reach:agent-groups-changed', cb),
  },
  questions: {
    state: () => ipcRenderer.invoke('questions:state') as Promise<QuestionState>,
    answer: (id, reply) => ipcRenderer.invoke('questions:answer', id, reply) as Promise<boolean>,
    dismiss: (id) => ipcRenderer.invoke('questions:dismiss', id) as Promise<boolean>,
    onChange: (cb) => listen('questions:changed', cb),
  },
}
