import type { ExtensionInfo } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  ArrowsClockwiseIcon,
  BellIcon,
  BookOpenTextIcon,
  BroadcastIcon,
  ChatCircleDotsIcon,
  DeviceMobileIcon,
  EyeSlashIcon,
  FileCodeIcon,
  GitBranchIcon,
  GlobeIcon,
  type Icon as IconComponent,
  InfoIcon,
  KeyboardIcon,
  KeyholeIcon,
  KeyIcon,
  LayoutIcon,
  PaletteIcon,
  PlugsIcon,
  PuzzlePieceIcon,
  RobotIcon,
  ShareNetworkIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SquareSplitHorizontalIcon,
  SquaresFourIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TreeStructureIcon,
  UserSwitchIcon,
} from '@phosphor-icons/react'
import type { Dict } from '@shared/app/dict'
import { withProductName } from '@/lib/app/useDict'
import { platform } from '@/platform'

export const SETTINGS_GROUPS = [
  'general',
  'terminal',
  'workspace',
  'agents',
  'editor',
  'security',
  'more',
] as const

type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]

export type SectionId =
  | 'manager'
  | 'claudeAccounts'
  | 'appearance'
  | 'terminal'
  | 'prompt'
  | 'keyboard'
  | 'panes'
  | 'notifications'
  | 'sidebar'
  | 'workspaces'
  | 'agents'
  | 'playbooks'
  | 'assistant'
  | 'files'
  | 'git'
  | 'ports'
  | 'browser'
  | 'passwords'
  | 'scriptTokens'
  | 'privacy'
  | 'editor'
  | 'extensions'
  | 'views'
  | 'remote'
  | 'sync'
  | 'shares'
  | 'about'
  | 'sandbox'
  | 'workspace'
  | 'extensionPage'

export interface SettingsSection {
  id: SectionId
  group: SettingsGroupId
  icon: IconComponent
  label: string
}

export function settingsSections(d: Dict): SettingsSection[] {
  return [
    { id: 'appearance', group: 'general', icon: PaletteIcon, label: d.settings.appearance },
    { id: 'notifications', group: 'general', icon: BellIcon, label: d.settings.notifications },
    { id: 'sync', group: 'general', icon: ArrowsClockwiseIcon, label: d.sync.title },
    { id: 'shares', group: 'general', icon: ShareNetworkIcon, label: d.shares.title },
    { id: 'terminal', group: 'terminal', icon: TerminalWindowIcon, label: d.settings.terminal },
    { id: 'prompt', group: 'terminal', icon: TerminalIcon, label: d.prompt.title },
    { id: 'keyboard', group: 'terminal', icon: KeyboardIcon, label: d.keyboard.title },
    {
      id: 'panes',
      group: 'terminal',
      icon: SquareSplitHorizontalIcon,
      label: d.settings.panes,
    },
    {
      id: 'workspaces',
      group: 'workspace',
      icon: SquaresFourIcon,
      label: d.workspaceSettings.title,
    },
    { id: 'sidebar', group: 'workspace', icon: SidebarSimpleIcon, label: d.settings.sidebar },
    { id: 'files', group: 'workspace', icon: TreeStructureIcon, label: d.settings.files },
    { id: 'git', group: 'workspace', icon: GitBranchIcon, label: d.git.title },
    { id: 'ports', group: 'workspace', icon: PlugsIcon, label: d.ports.title },
    { id: 'views', group: 'workspace', icon: LayoutIcon, label: d.views.title },
    {
      id: 'claudeAccounts',
      group: 'agents',
      icon: UserSwitchIcon,
      label: d.claudeAccounts.title,
    },
    { id: 'agents', group: 'agents', icon: RobotIcon, label: d.settings.agents },
    { id: 'playbooks', group: 'agents', icon: BookOpenTextIcon, label: d.playbooks.title },
    {
      id: 'assistant',
      group: 'agents',
      icon: ChatCircleDotsIcon,
      label: d.assistantSettings.title,
    },
    ...(platform === 'linux'
      ? [
          {
            id: 'manager' as const,
            group: 'agents' as const,
            icon: BroadcastIcon,
            label: d.manager.settingsTitle,
          },
        ]
      : []),
    { id: 'editor', group: 'editor', icon: FileCodeIcon, label: d.editorSettings.title },
    { id: 'browser', group: 'editor', icon: GlobeIcon, label: d.browserSettings.title },
    { id: 'sandbox', group: 'security', icon: ShieldCheckIcon, label: d.sandbox.title },
    { id: 'privacy', group: 'security', icon: EyeSlashIcon, label: d.privacy.title },
    { id: 'passwords', group: 'security', icon: KeyIcon, label: d.passwords.title },
    { id: 'scriptTokens', group: 'security', icon: KeyholeIcon, label: d.scriptTokens.title },
    { id: 'extensions', group: 'more', icon: PuzzlePieceIcon, label: d.settings.extensions },
    { id: 'remote', group: 'more', icon: DeviceMobileIcon, label: d.settings.remote },
    { id: 'about', group: 'more', icon: InfoIcon, label: d.settings.about },
  ]
}

export function pageTitle(ext: ExtensionInfo): string {
  return withProductName(ext.settingsPage?.title ?? ext.name)
}

export function extensionPageResultId(extId: string): string {
  return `extension-page:${extId}`
}
