import type { SearchApi } from './files/search'
import type { LspApi } from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { PreviewApi } from './artifacts/htmlPreview'
import type { ExtensionsApi } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import type { FileOpsApi } from './files/fileOps'
import type { MarketplaceApi } from './extensions/marketplace'
import type { SuggestionsApi } from './extensions/extensionSuggestions'
import type { GitBridge } from './boards/git'
import type { PortsBridge } from './boards/ports'
import type { AssistApi } from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { ChatSessionsApi } from './assist/chatSessions'
import type { PrivacyApi } from './privacy/redaction'
import type { TelemetryApi } from './privacy/telemetry'
import type { ChatToolsApi } from './assist/chatTools'
import type { IconThemesApi } from '@aurigax-ai/ostia-extension-sdk/contract/iconTheme'
import type { LanguagePacksApi } from '@aurigax-ai/ostia-extension-sdk/contract/languagePack'
import type { KeymapsApi } from './keyboard/keymapFile'
import type { EditorLanguagesApi } from '@aurigax-ai/ostia-extension-sdk/contract/editorLanguages'
import type { ViewsApi } from './views/views'
import type { WindowsBridge } from './windows/windowsApi'
import type { CommandsBridge } from './control/commands'
import type { AppBridge } from './app/appApi'
import type { PtyBridge } from './terminal/ptyApi'
import type { AgentsBridge } from './agents/agentsApi'
import type { FilesBridge } from './files/filesApi'
import type { WorkspaceBridge } from './workspaces/workspaceApi'
import type { AttentionBridge } from './attention/attention'
import type { ProfileSyncBridge } from './profileSync/profileSync'
import type { SandboxBridge } from './sandbox/sandboxApi'
import type { PermissionsBridge } from './permissions/permissionsApi'
import type { BrowserBridge } from './browser/browserApi'
import type { ArtifactsBridge } from './artifacts/artifactsApi'
import type { GatewayBridge } from './gateway/gatewayApi'

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
    SandboxBridge,
    PermissionsBridge,
    BrowserBridge,
    ArtifactsBridge,
    GatewayBridge {
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
