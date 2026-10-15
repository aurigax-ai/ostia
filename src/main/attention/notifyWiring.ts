import type { BrowserWindow } from 'electron'
import type { CommandTarget } from '../../shared/types'
import type { CommandResult } from '../../shared/types'
import type { Redactor } from '../privacy/redaction'
import { registerNotifyIpc, registerNotifyMethods } from './notify'

interface NotifyWiringDeps {
  execCommand: (
    target: CommandTarget,
    id: string,
    args?: unknown,
    fromMain?: boolean,
  ) => Promise<CommandResult>
  isScratchPane: (paneId: string) => boolean
  windows: Map<string, BrowserWindow>
  redactor: Redactor
}

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
