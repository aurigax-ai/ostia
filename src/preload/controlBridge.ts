import { ipcRenderer } from 'electron'
import type { OstiaBridge } from '../shared/types'
import { answer } from './listen'

export const controlBridge: Pick<OstiaBridge, 'commands' | 'terminalState'> = {
  commands: {
    publish: (descriptors) => ipcRenderer.send('commands:register', descriptors),
    onInvoke: (handler) => answer('command:invoke', 'command:result', handler),
  },
  terminalState: {
    push: (snapshot) => ipcRenderer.send('terminal:state', snapshot),
  },
}
