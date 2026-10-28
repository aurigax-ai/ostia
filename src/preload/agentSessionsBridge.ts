import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { listen } from './listen'

export const agentSessionsBridge: Pick<OstiaBridge, 'agentSessions'> = {
  agentSessions: {
    open: (sessionId, options) => ipcRenderer.invoke('agent:open', sessionId, options),
    prompt: (sessionId, text) => ipcRenderer.invoke('agent:prompt', sessionId, text),
    abort: (sessionId) => ipcRenderer.invoke('agent:abort', sessionId),
    close: (sessionId) => ipcRenderer.invoke('agent:close', sessionId),
    answerTool: (callId, reply) => ipcRenderer.send('agent:tool-result', callId, reply),
    coreCall: (sessionId, callId) => ipcRenderer.invoke('agent:core-call', sessionId, callId),
    onEvent: (cb) => listen('agent:event', cb),
    onToolCall: (cb) => listen('agent:tool-call', cb),
    onToolCancel: (cb) => listen('agent:tool-cancel', cb),
  },
}
