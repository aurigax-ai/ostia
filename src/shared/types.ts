import type { AssistApi } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { EditorLanguagesApi } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import type { ExtensionsApi } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { IconThemesApi } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import type { LanguagePacksApi } from '@aurigax-ai/ostia-extension-sdk/contract/languagePack'
import type { LspApi } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { AgentSessionsApi } from './agent/agentApi'
import type { AgentsBridge } from './agents/agentsApi'
import type { AppBridge } from './app/appApi'
import type { ArtifactsBridge } from './artifacts/artifactsApi'
import type { PreviewApi } from './artifacts/htmlPreview'
import type { ChatSessionsApi } from './assist/chatSessions'
import type { ChatToolsApi } from './assist/chatTools'
import type { AttentionBridge } from './attention/attention'
import type { GitBridge } from './boards/git'
import type { PortsBridge } from './boards/ports'
import type { BrowserBridge } from './browser/browserApi'
import type { CommandsBridge } from './control/commands'
import type { SuggestionsApi } from './extensions/extensionSuggestions'
import type { MarketplaceApi } from './extensions/marketplace'
import type { FileOpsApi } from './files/fileOps'
import type { FilesBridge } from './files/filesApi'
import type { SearchApi } from './files/search'
import type { GatewayBridge } from './gateway/gatewayApi'
import type { KeymapsApi } from './keyboard/keymapFile'
import type { PermissionsBridge } from './permissions/permissionsApi'
import type { PrivacyApi } from './privacy/redaction'
import type { TelemetryApi } from './privacy/telemetry'
import type { ProfileSyncBridge } from './profileSync/profileSync'
import type { ServerSyncBridge } from './profileSync/serverSync'
import type { SandboxBridge } from './sandbox/sandboxApi'
import type { ServerBridge } from './server/serverApi'
import type { PtyBridge } from './terminal/ptyApi'
import type { ViewsApi } from './views/views'
import type { WindowsBridge } from './windows/windowsApi'
import type { WorkspaceBridge } from './workspaces/workspaceApi'

export type Platform = 'darwin' | 'linux' | 'win32' | (string & {})

export interface AppInfo {
  name: string
  version: string
  platform: Platform
  hostName: string
  home: string
  desktops: string[]
}

export interface OstiaBridge
  extends WindowsBridge,
    CommandsBridge,
    AppBridge,
    PtyBridge,
    AgentsBridge,
    FilesBridge,
    WorkspaceBridge,
    AttentionBridge,
    ProfileSyncBridge,
    ServerSyncBridge,
    SandboxBridge,
    PermissionsBridge,
    BrowserBridge,
    ArtifactsBridge,
    GatewayBridge,
    ServerBridge {
  ping: () => Promise<'pong'>
  info: () => Promise<AppInfo>
  platform: Platform
  search: SearchApi
  lsp: LspApi
  preview: PreviewApi
  extensions: ExtensionsApi
  fileOps: FileOpsApi
  marketplace: MarketplaceApi
  suggestions: SuggestionsApi
  git: GitBridge
  ports: PortsBridge
  assist: AssistApi & { wake: () => void }
  chatSessions: ChatSessionsApi
  agentSessions: AgentSessionsApi
  privacy: PrivacyApi
  telemetry: TelemetryApi
  chatTools: ChatToolsApi
  iconThemes: IconThemesApi
  languagePacks: LanguagePacksApi
  keymaps: KeymapsApi
  editorLanguages: EditorLanguagesApi
  views: ViewsApi
}

declare global {
  interface Window {
    ostia: OstiaBridge
  }
}
