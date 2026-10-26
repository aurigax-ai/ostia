import { ipcMain } from 'electron'
import type {
  GatewayPhoneWorkspace,
  GatewayPhoneWorkspaceResult,
} from '../../../shared/gateway/gatewayApi'
import {
  loadPhoneWorkspace,
  type PhoneWorkspace,
  type PhoneWorkspacePaths,
  phoneFolderState,
  setPhoneWorkspace,
} from './phoneWorkspace'

export interface PhoneWorkspaceIpcDeps {
  paths: () => PhoneWorkspacePaths
}

function shown(phone: PhoneWorkspace, paths: PhoneWorkspacePaths): GatewayPhoneWorkspace {
  const { folder, problem, absent } = phoneFolderState(phone, paths)
  return {
    ...phone,
    folder,
    isDefault: phone.folder === null,
    absent,
    ...(problem ? { problem } : {}),
  }
}

export function registerPhoneWorkspaceIpc(deps: PhoneWorkspaceIpcDeps): void {
  ipcMain.handle('gateway:phone-workspace', () => shown(loadPhoneWorkspace(), deps.paths()))
  ipcMain.handle('gateway:set-phone-workspace', (e, raw: unknown): GatewayPhoneWorkspaceResult => {
    if (e.sender.getType() !== 'window') return { ok: false, error: 'not-a-window' }
    const paths = deps.paths()
    const saved = setPhoneWorkspace(raw, paths)
    return saved.ok ? { ok: true, value: shown(saved.value, paths) } : saved
  })
}
