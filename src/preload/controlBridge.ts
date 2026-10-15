import { ipcRenderer } from 'electron'
import type { CommandInvokeRequest, OstiaBridge } from '../shared/types'

export const controlBridge: Pick<OstiaBridge, 'commands' | 'terminalState'> = {
  commands: {
    publish: (descriptors) => ipcRenderer.send('commands:register', descriptors),
    onInvoke: (handler) => {
      const listener = async (
        _e: unknown,
        reqId: string,
        req: CommandInvokeRequest,
      ): Promise<void> => {
        const result = await handler(req)
        ipcRenderer.send('command:result', reqId, result)
      }
      ipcRenderer.on('command:invoke', listener)
      return () => ipcRenderer.removeListener('command:invoke', listener)
    },
  },
  terminalState: {
    push: (snapshot) => ipcRenderer.send('terminal:state', snapshot),
  },
}
