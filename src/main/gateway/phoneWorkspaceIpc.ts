import { ipcMain } from 'electron'
import type {
  GatewayPhoneWorkspace,
  GatewayPhoneWorkspaceResult,
} from '../../shared/gateway/gatewayApi'
import { folderTrust } from '../agents/claudeFolderTrust'
import {
  type PhoneWorkspace,
  type PhoneWorkspacePaths,
  folderOf,
  folderRefusal,
  loadPhoneWorkspace,
  setPhoneWorkspace,
} from './phoneWorkspace'

export interface PhoneWorkspaceIpcDeps {
  paths: () => PhoneWorkspacePaths
}

async function shown(
  phone: PhoneWorkspace,
  paths: PhoneWorkspacePaths,
): Promise<GatewayPhoneWorkspace> {
  const folder = folderOf(phone, paths)
  const shownPhone = { ...phone, folder, isDefault: phone.folder === null }
  const problem = folderRefusal(folder, paths)
  if (problem) return { ...shownPhone, trust: 'unknown', problem }
  const trust = await folderTrust({
    folder,
    workDir: folder,
    home: paths.home,
    configDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    customOAuth: Boolean(process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL),
  }).catch(() => ({ state: 'unknown' as const }))
  return { ...shownPhone, trust: trust.state }
}

export function registerPhoneWorkspaceIpc(deps: PhoneWorkspaceIpcDeps): void {
  ipcMain.handle('gateway:phone-workspace', () => shown(loadPhoneWorkspace(), deps.paths()))
  ipcMain.handle(
    'gateway:set-phone-workspace',
    async (e, raw: unknown): Promise<GatewayPhoneWorkspaceResult> => {
      if (e.sender.getType() !== 'window') return { ok: false, error: 'not-a-window' }
      const paths = deps.paths()
      const saved = setPhoneWorkspace(raw, paths)
      return saved.ok ? { ok: true, value: await shown(saved.value, paths) } : saved
    },
  )
}
