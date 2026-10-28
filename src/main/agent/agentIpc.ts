import { type IpcMainEvent, type IpcMainInvokeEvent, ipcMain } from 'electron'
import { openInputOf } from './agentRequests'
import type { AgentSessions } from './agentSessions'

export function registerAgentIpc(sessions: () => AgentSessions | null): void {
  const unavailable = { ok: false, error: 'unavailable' }
  ipcMain.handle('agent:open', (e: IpcMainInvokeEvent, sessionId: unknown, options: unknown) => {
    const input = openInputOf(sessionId, options)
    const current = sessions()
    if (!current) return unavailable
    return input ? current.open(e.sender, input) : { ok: false, error: 'invalid' }
  })
  ipcMain.handle('agent:prompt', (e: IpcMainInvokeEvent, sessionId: unknown, text: unknown) => {
    return sessions()?.prompt(e.sender, sessionId, text) ?? unavailable
  })
  ipcMain.handle('agent:abort', (e: IpcMainInvokeEvent, sessionId: unknown) => {
    return sessions()?.abort(e.sender, sessionId) ?? unavailable
  })
  ipcMain.handle('agent:close', (e: IpcMainInvokeEvent, sessionId: unknown) => {
    return sessions()?.close(e.sender, sessionId) ?? unavailable
  })
  ipcMain.handle(
    'agent:core-call',
    (e: IpcMainInvokeEvent, sessionId: unknown, callId: unknown) => {
      return sessions()?.coreCall(e.sender, sessionId, callId) ?? unavailable
    },
  )
  ipcMain.on('agent:tool-result', (e: IpcMainEvent, callId: unknown, reply: unknown) => {
    sessions()?.answerTool(e.sender, callId, reply)
  })
}
