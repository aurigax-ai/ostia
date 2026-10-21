import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { Dict } from '../../shared/app/dict'
import { parseChatToolSettings } from '../../shared/assist/chatTools'
import type { ExtensionHost } from '../extensions/extensionHost'
import type { ExtensionSecretStore } from '../extensions/extensionHostDeps'
import type { SecretStoreDeps } from '../extensions/extensionSecrets'
import { storePath } from '../platform/jsonStore'
import { readSettingsFile } from '../platform/settingsFile'
import type { Redactor } from '../privacy/redaction'
import { playbooksFolder } from '../terminal/shellIntegration'
import type { WindowSend } from '../windows/windowSend'
import { registerAssistIpc } from './assistIpc'
import { createChatSessionStore } from './chatSessions'
import { registerChatSessionIpc } from './chatSessionsIpc'
import { ChatToolGrants } from './chatToolGrants'
import { registerChatToolsIpc } from './chatToolsIpc'
import { McpHost } from './mcpHost'
import { McpOAuth, mcpOAuthBrowser } from './mcpOAuth'
import { createMcpOAuthStore } from './mcpOAuthStore'

interface ChatStartDeps {
  services: {
    extensionHost: ExtensionHost | null
    mcpHost: McpHost | null
    mcpOAuth: McpOAuth | null
  }
  redactor: Redactor
  encryptedStore: (path: string) => ExtensionSecretStore
  encryptedFile: (path: string) => SecretStoreDeps
  openExternalSafe: (url: string) => boolean
  mainStrings: () => Dict
  broadcast: WindowSend['broadcast']
  fileRoots: () => string[]
}

export function startChat({
  services,
  redactor,
  encryptedStore,
  encryptedFile,
  openExternalSafe,
  mainStrings,
  broadcast,
  fileRoots,
}: ChatStartDeps) {
  registerAssistIpc(() => services.extensionHost?.assistant ?? null)
  registerChatSessionIpc(
    createChatSessionStore({ dir: join(dirname(storePath('chat', 'global')), 'chat-sessions') }),
    redactor.text,
  )
  const mcpSecretsPath = storePath('mcp-secrets', 'global')
  const mcpSecrets = encryptedStore(mcpSecretsPath)
  const chatToolSettings = () => parseChatToolSettings(readSettingsFile().assistant)
  services.mcpOAuth = new McpOAuth({
    store: createMcpOAuthStore(encryptedFile(mcpSecretsPath)),
    openExternal: openExternalSafe,
    browser: mcpOAuthBrowser(app.isPackaged, process.env),
    pages: () => mainStrings().native.signIn,
    onChange: () => services.mcpHost?.notify(),
  })
  services.mcpHost = new McpHost({
    servers: () => chatToolSettings().mcpServers,
    secret: (server, key) => mcpSecrets.get(server, key),
    onStatus: (status) => broadcast('chatTools:mcp-status', status),
    auth: services.mcpOAuth,
  })
  registerChatToolsIpc({
    roots: fileRoots,
    settings: chatToolSettings,
    playbooksFolder,
    mcp: services.mcpHost,
    secrets: mcpSecrets,
    oauth: services.mcpOAuth,
    grants: new ChatToolGrants(join(app.getPath('userData'), 'chat-tool-grants.json')),
    onGrants: (keys) => broadcast('chatTools:always-grants', keys),
  })
}
