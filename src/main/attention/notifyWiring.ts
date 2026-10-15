import type { BrowserWindow } from 'electron'
import type { CommandBridge } from '../control/commandBridge'
import type { Redactor } from '../privacy/redaction'
import { registerNotifyIpc, registerNotifyMethods } from './notify'

interface NotifyWiringDeps {
  execCommand: CommandBridge['execCommand']
  isScratchPane: (paneId: string) => boolean
  windows: Map<string, BrowserWindow>
  redactor: Redactor
}

export type NotifyWiring = ReturnType<typeof registerNotifyWiring>

export function registerNotifyWiring({
  execCommand,
  isScratchPane,
  windows,
  redactor,
}: NotifyWiringDeps) {
  const notifyDeps = {
    execCommand,
    isScratchPane,
    windows: () => windows.values(),
    windowById: (id: string) => windows.get(id),
    redact: redactor.text,
  }
  registerNotifyMethods(notifyDeps)
  registerNotifyIpc(notifyDeps)

  return { notifyDeps }
}
