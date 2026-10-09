import { type IpcMainInvokeEvent, ipcMain } from 'electron'
import {
  type ChatFsTarget,
  type ChatPlanRequest,
  type ChatPreviewRequest,
  type ChatReadRequest,
  type ChatRestoreRequest,
  type ChatSearchRequest,
  type ChatToolSettings,
  type ChatWriteRequest,
  type McpSecretResult,
  type McpServerStatus,
  type McpSignInResult,
  isMcpSecretKey,
  mcpTransportOf,
} from '../../shared/chatTools'
import type { ExtensionSecretStore } from '../extensions/extensionHost'
import {
  listTool,
  planEditTool,
  previewTool,
  readTool,
  restoreTool,
  searchTool,
  writeTool,
} from './chatFsTools'
import { listSkills, loadSkill } from './chatSkills'
import type { ChatToolGrants } from './chatToolGrants'
import { type McpHost, serverSecrets } from './mcpHost'
import type { McpOAuth } from './mcpOAuth'

export interface ChatToolsDeps {
  roots: () => string[]
  settings: () => ChatToolSettings
  mcp: McpHost
  secrets: ExtensionSecretStore
  oauth: McpOAuth
  grants: ChatToolGrants
  onGrants: (keys: string[]) => void
}

export async function signInToMcp(
  deps: Pick<ChatToolsDeps, 'settings' | 'mcp' | 'secrets' | 'oauth'>,
  server: unknown,
): Promise<McpSignInResult> {
  const settings = deps.settings().mcpServers.find((s) => s.name === server)
  const result = await deps.oauth.signIn(
    settings,
    settings ? serverSecrets(settings, (name, key) => deps.secrets.get(name, key)) : {},
  )
  if (result.ok && settings) deps.mcp.reconnect(settings.name)
  return result
}

export function signOutOfMcp(
  deps: Pick<ChatToolsDeps, 'settings' | 'mcp' | 'oauth'>,
  server: unknown,
): McpServerStatus[] {
  const settings = deps.settings().mcpServers.find((s) => s.name === server)
  if (!settings) return deps.mcp.status()
  deps.oauth.signOut(settings.name)
  return deps.mcp.reconnect(settings.name)
}

export function setMcpSecret(
  deps: Pick<ChatToolsDeps, 'settings' | 'mcp' | 'secrets'>,
  server: unknown,
  key: unknown,
  value: unknown,
): McpSecretResult {
  const settings = deps.settings().mcpServers.find((s) => s.name === server)
  if (!settings) return { ok: false, error: 'unknown-server' }
  if (!isMcpSecretKey(mcpTransportOf(settings), key) || !settings.secrets.includes(key)) {
    return { ok: false, error: 'unknown-secret' }
  }
  if (value !== null && typeof value !== 'string') return { ok: false, error: 'invalid-value' }
  const res = deps.secrets.set(settings.name, key, value)
  if (res.ok) deps.mcp.reconnect(settings.name)
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}

function fromWindow(e: IpcMainInvokeEvent): boolean {
  return e.sender.getType() === 'window'
}

function changeAlwaysGrant(
  deps: Pick<ChatToolsDeps, 'grants' | 'onGrants'>,
  e: IpcMainInvokeEvent,
  change: 'add' | 'remove',
  key: unknown,
): string[] {
  if (!fromWindow(e)) return deps.grants.list()
  const changed = change === 'add' ? deps.grants.add(key) : deps.grants.remove(key)
  const keys = deps.grants.list()
  if (changed) deps.onGrants(keys)
  return keys
}

export function registerChatToolsIpc(deps: ChatToolsDeps): void {
  ipcMain.handle('chatTools:read', (_e, req: ChatReadRequest) => readTool(req, deps.roots()))
  ipcMain.handle('chatTools:list', (_e, req: ChatFsTarget) => listTool(req, deps.roots()))
  ipcMain.handle('chatTools:search', (_e, req: ChatSearchRequest) => searchTool(req, deps.roots()))
  ipcMain.handle('chatTools:preview', (_e, req: ChatPreviewRequest) =>
    previewTool(req, deps.roots()),
  )
  ipcMain.handle('chatTools:plan', (_e, req: ChatPlanRequest) => planEditTool(req, deps.roots()))
  ipcMain.handle('chatTools:write', (_e, req: ChatWriteRequest) => writeTool(req, deps.roots()))
  ipcMain.handle('chatTools:restore', (_e, req: ChatRestoreRequest) =>
    restoreTool(req, deps.roots()),
  )
  ipcMain.handle('chatTools:skills', () => listSkills(deps.settings().skillFolders))
  ipcMain.handle('chatTools:load-skill', (_e, name: unknown) =>
    loadSkill(deps.settings().skillFolders, name),
  )
  ipcMain.handle('chatTools:mcp-status', () => deps.mcp.status())
  ipcMain.handle('chatTools:mcp-refresh', () => deps.mcp.refresh())
  ipcMain.handle('chatTools:mcp-reconnect', (_e, server: unknown) =>
    typeof server === 'string' ? deps.mcp.reconnect(server) : deps.mcp.status(),
  )
  ipcMain.handle(
    'chatTools:mcp-call',
    (_e, callId: unknown, server: unknown, tool: unknown, input: unknown) =>
      deps.mcp.call(callId, server, tool, input),
  )
  ipcMain.on('chatTools:mcp-cancel', (_e, callId: unknown) => deps.mcp.cancel(callId))
  ipcMain.handle('chatTools:set-mcp-secret', (_e, server: unknown, key: unknown, value: unknown) =>
    setMcpSecret(deps, server, key, value),
  )
  ipcMain.handle('chatTools:mcp-sign-in', (_e, server: unknown) => signInToMcp(deps, server))
  ipcMain.on('chatTools:mcp-cancel-sign-in', (_e, server: unknown) => deps.oauth.cancel(server))
  ipcMain.handle('chatTools:mcp-sign-out', (_e, server: unknown) => signOutOfMcp(deps, server))
  ipcMain.handle('chatTools:mcp-test', (_e, server: unknown) => deps.mcp.test(server))
  ipcMain.handle('chatTools:always-grants', () => deps.grants.list())
  ipcMain.handle('chatTools:grant-always', (e, key: unknown) =>
    changeAlwaysGrant(deps, e, 'add', key),
  )
  ipcMain.handle('chatTools:remove-always-grant', (e, key: unknown) =>
    changeAlwaysGrant(deps, e, 'remove', key),
  )
}
