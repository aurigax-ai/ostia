import { capLabel } from '@/components/agents/ApprovalCard'
import { AssistantSection } from '@/components/assist/AssistantSection'
import { Hint } from '@/components/common/Hint'
import { IconButton } from '@/components/common/IconButton'
import { TextLink } from '@/components/common/TextLink'
import { LanguagesSection } from '@/components/editor/LanguagesSection'
import { BrowseExtensions } from '@/components/extensions/BrowseExtensions'
import { ExtensionSettingsForm } from '@/components/extensions/ExtensionSettingsForm'
import {
  type ExtensionAnchor,
  ExtensionsSection,
} from '@/components/extensions/InstalledExtensions'
import { extensionIcon } from '@/components/extensions/extensionIcons'
import { KeyboardSection } from '@/components/keyboard/KeyboardSection'
import { SandboxSection } from '@/components/sandbox/SandboxSection'
import { WorkspaceSandboxPage } from '@/components/sandbox/WorkspaceSandboxPage'
import { UpdateCheck } from '@/components/shell/UpdateCheck'
import { Alert, AlertAction, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { ViewsSection } from '@/components/views/ViewsSection'
import { fmt, useDict, withProductName } from '@/i18n/useDict'
import {
  EXTENSIONS_NAV_EXPANDED_KEY,
  SANDBOX_NAV_EXPANDED_KEY,
  navExpanded,
  rememberNavExpanded,
} from '@/lib/app/settingsNav'
import { firstMatchControl, matchesQuery } from '@/lib/app/settingsSearch'
import { countUsage } from '@/lib/app/usageCounts'
import { extensionMatchesQuery } from '@/lib/extensions/extensionSettingText'
import { openFileInWorkspace } from '@/lib/files/openFile'
import { ghosttyFailure } from '@/lib/terminal/ghosttyEngine'
import { ACCENT_PRESETS, normalizeHex } from '@/lib/theme/color'
import { useEffectiveTheme } from '@/lib/theme/theme'
import { cn } from '@/lib/utils'
import { isLinux, isMac, platform } from '@/platform'
import type { ClipboardKeys, TerminalRenderer } from '@/settings/terminalPaneSettings'
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  TERMINAL_RENDERERS,
} from '@/settings/terminalPaneSettings'
import { WINDOW_TITLE_MAX } from '@/settings/windowTitle'
import {
  CURSOR_STYLES,
  type CursorStyle,
  FONT_WEIGHTS,
  type FontSurface,
  HIBERNATION_IDLE_MAX,
  HIBERNATION_IDLE_MIN,
  HIBERNATION_LIVE_MAX,
  INPUT_MODES,
  type InputMode,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MOTION_MODES,
  type MotionMode,
  motionMode,
  useSettingsStore,
} from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useExtensionsStore } from '@/stores/extensions/extensionsStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import {
  ArrowsClockwiseIcon,
  BellIcon,
  BracketsCurlyIcon,
  BroadcastIcon,
  CaretRightIcon,
  ChatCircleDotsIcon,
  CheckIcon,
  CopyIcon,
  DeviceMobileIcon,
  EyeSlashIcon,
  FileCodeIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GlobeIcon,
  type Icon as IconComponent,
  InfoIcon,
  KeyIcon,
  KeyboardIcon,
  LayoutIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  PlugsIcon,
  PlusIcon,
  PuzzlePieceIcon,
  RobotIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SquareSplitHorizontalIcon,
  SquaresFourIcon,
  StorefrontIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TranslateIcon,
  TreeStructureIcon,
  WarningIcon,
} from '@phosphor-icons/react'
import type { Dict, Locale } from '@shared/app/dict'
import {
  BELL_MODES,
  type BellMode,
  LONG_COMMAND_MAX_SECONDS,
  LONG_COMMAND_MIN_SECONDS,
  clampLongCommandSeconds,
} from '@shared/app/notificationSettings'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@shared/app/zoom'
import type { Capability } from '@shared/capabilities'
import { type ExtensionInfo, PRODUCT_PLACEHOLDER } from '@shared/extensions'
import type { ApprovalMode } from '@shared/permissions/approvals'
import { REACH_MODES, type ReachMode, parseReachMode } from '@shared/permissions/reach'
import { PRODUCT_DISPLAY_NAME } from '@shared/productDisplay'
import { KEEP_SHELLS_FEATURE, TMUX_MIN_VERSION } from '@shared/terminal/keepShells'
import type { AppInfo, Platform } from '@shared/types'
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import appIcon from '../../../../resources/icon.svg'
import { ActionsSection } from './ActionsSection'
import { GitSection, PortsSection } from './BoardSettings'
import { BrowserSettingsSection, EditorSettingsSection } from './BrowserEditorSettings'
import { DiscreteGpuRow } from './DiscreteGpuRow'
import { FileTreeSettingsGroups } from './FilesSettingsSection'
import { FontPicker } from './FontPicker'
import { GatewaySection } from './GatewaySection'
import { ManagerSection } from './ManagerSection'
import { PasswordsSection } from './PasswordsSection'
import { PrivacySection } from './PrivacySection'
import { PromptSection } from './PromptSection'
import { RequirementsNoteView, useRequirements } from './RequirementsNote'
import {
  Highlight,
  SearchScopeProvider,
  type SearchStore,
  SettingsSearchSection,
  createSearchStore,
  useSearchGroup,
  useSearchLeaf,
  useSearchRow,
  useSettingsSearch,
} from './SettingsSearch'
import { SyncSection } from './SyncSection'
import { ThemeRows } from './ThemeSettings'
import { WorkspacesSection } from './WorkspacesSection'

const SETTINGS_GROUPS = [
  'general',
  'terminal',
  'workspace',
  'agents',
  'editor',
  'security',
  'more',
] as const

type SettingsGroup = (typeof SETTINGS_GROUPS)[number]

type SectionId =
  | 'manager'
  | 'appearance'
  | 'terminal'
  | 'prompt'
  | 'keyboard'
  | 'panes'
  | 'notifications'
  | 'sidebar'
  | 'workspaces'
  | 'agents'
  | 'assistant'
  | 'files'
  | 'git'
  | 'ports'
  | 'browser'
  | 'passwords'
  | 'privacy'
  | 'editor'
  | 'extensions'
  | 'browseExtensions'
  | 'views'
  | 'languageServers'
  | 'remote'
  | 'sync'
  | 'language'
  | 'about'
  | 'sandbox'
  | 'workspace'
  | 'extensionPage'

const EXTENSIONS_NAV_LIST_ID = 'settings-nav-extensions'
const SANDBOX_NAV_LIST_ID = 'settings-nav-sandbox'
const SANDBOX_DEFAULTS_ITEM = ''

interface NavChild {
  id: string
  label: string
  icon: IconComponent | null
  current: boolean
}

interface SettingsSection {
  id: SectionId
  group: SettingsGroup
  icon: IconComponent
  label: string
}

export function settingsSections(d: Dict): SettingsSection[] {
  return [
    { id: 'appearance', group: 'general', icon: PaletteIcon, label: d.settings.appearance },
    { id: 'language', group: 'general', icon: TranslateIcon, label: d.settings.language },
    { id: 'notifications', group: 'general', icon: BellIcon, label: d.settings.notifications },
    { id: 'sync', group: 'general', icon: ArrowsClockwiseIcon, label: d.sync.title },
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
    { id: 'agents', group: 'agents', icon: RobotIcon, label: d.settings.agents },
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
    {
      id: 'languageServers',
      group: 'editor',
      icon: BracketsCurlyIcon,
      label: d.languageServers.title,
    },
    { id: 'browser', group: 'editor', icon: GlobeIcon, label: d.browserSettings.title },
    { id: 'sandbox', group: 'security', icon: ShieldCheckIcon, label: d.sandbox.title },
    { id: 'privacy', group: 'security', icon: EyeSlashIcon, label: d.privacy.title },
    { id: 'passwords', group: 'security', icon: KeyIcon, label: d.passwords.title },
    { id: 'extensions', group: 'more', icon: PuzzlePieceIcon, label: d.settings.extensions },
    {
      id: 'browseExtensions',
      group: 'more',
      icon: StorefrontIcon,
      label: d.extensionsBrowse.title,
    },
    { id: 'remote', group: 'more', icon: DeviceMobileIcon, label: d.settings.remote },
    { id: 'about', group: 'more', icon: InfoIcon, label: d.settings.about },
  ]
}

export function SettingsPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.settingsActive)
  const close = useUIStore((s) => s.showWorkspaces)
  const [active, setActive] = useState<SectionId>('appearance')
  const requested = useUIStore((s) => s.settingsSection)
  const requestedExtension = useUIStore((s) => s.settingsExtension)
  const requestedQuery = useUIStore((s) => s.settingsQuery)
  const extensions = useExtensionsStore((s) => s.list)
  const [extensionsExpanded, setExtensionsExpanded] = useState(() =>
    navExpanded(EXTENSIONS_NAV_EXPANDED_KEY),
  )
  const [sandboxExpanded, setSandboxExpanded] = useState(() =>
    navExpanded(SANDBOX_NAV_EXPANDED_KEY),
  )
  const sandboxButtonRef = useRef<HTMLButtonElement>(null)
  const workspaces = useWorkspacesStore((s) => s.workspaces)
  const [anchor, setAnchor] = useState<ExtensionAnchor | null>(null)
  const [pageExtId, setPageExtId] = useState<string | null>(null)
  const extensionsButtonRef = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState('')
  const [searchStore] = useState(createSearchStore)
  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next)
      searchStore.set(next.trim().toLowerCase())
    },
    [searchStore],
  )
  const [searchHits, setSearchHits] = useState<Record<string, number>>({})
  const onSearchHits = useCallback(
    (id: string, hits: number) =>
      setSearchHits((prev) => (prev[id] === hits ? prev : { ...prev, [id]: hits })),
    [],
  )
  const contentRef = useRef<HTMLDivElement>(null)
  const settingsWorkspaceId = useUIStore((s) => s.settingsWorkspaceId)
  const settingsRequest = useUIStore((s) => s.settingsRequest)
  const targetWorkspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === settingsWorkspaceId),
  )

  useEffect(() => {
    if (open) countUsage('features', 'settings', active)
  }, [open, active])

  useEffect(() => {
    if (settingsRequest === 0) return
    setActive('workspace')
    setSandboxExpanded(true)
    rememberNavExpanded(SANDBOX_NAV_EXPANDED_KEY, true)
  }, [settingsRequest])
  const navRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    navRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    return () => prev?.focus?.()
  }, [open])

  const sections = useMemo(() => settingsSections(d), [d])

  const expandExtensions = (expanded: boolean): void => {
    setExtensionsExpanded(expanded)
    rememberNavExpanded(EXTENSIONS_NAV_EXPANDED_KEY, expanded)
  }

  const expandSandbox = (expanded: boolean): void => {
    setSandboxExpanded(expanded)
    rememberNavExpanded(SANDBOX_NAV_EXPANDED_KEY, expanded)
  }

  const openSandboxItem = (id: string): void => {
    if (id === SANDBOX_DEFAULTS_ITEM) {
      openSection('sandbox')
      return
    }
    changeQuery('')
    useUIStore.setState({ settingsWorkspaceId: id })
    openSection('workspace')
  }

  const revealResult = (id: string): void => {
    contentRef.current
      ?.querySelector(`[data-settings-result="${id}"]`)
      ?.scrollIntoView({ block: 'start' })
  }

  const openSection = (id: SectionId): void => {
    setActive(id)
    setAnchor(null)
    revealResult(id)
  }

  const openExtension = (id: string): void => {
    setActive('extensions')
    setAnchor((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  const openExtensionPage = (id: string): void => {
    setActive('extensionPage')
    setPageExtId(id)
    setAnchor(null)
    revealResult(extensionPageResultId(id))
  }

  useEffect(() => {
    if (!requested) return
    if (
      requested === 'extensions' &&
      requestedExtension &&
      extensions.some((e) => e.id === requestedExtension && e.settingsPage)
    ) {
      setActive('extensionPage')
      setPageExtId(requestedExtension)
      setAnchor(null)
    } else if (sections.some((s) => s.id === requested)) {
      setActive(requested as SectionId)
      if (requested === 'extensions' && requestedExtension) {
        setAnchor((prev) => ({ id: requestedExtension, nonce: (prev?.nonce ?? 0) + 1 }))
        setExtensionsExpanded(true)
        rememberNavExpanded(EXTENSIONS_NAV_EXPANDED_KEY, true)
      } else {
        setAnchor(null)
      }
    }
    useUIStore.setState({ settingsSection: null, settingsExtension: null })
  }, [requested, requestedExtension, sections, extensions])

  useEffect(() => {
    if (requestedQuery === null) return
    changeQuery(requestedQuery)
    useUIStore.setState({ settingsQuery: null })
  }, [requestedQuery, changeQuery])

  const openSettingsFile = async (): Promise<void> => {
    const path = await window.ostia.settings.path()
    close()
    openFileInWorkspace(path)
  }

  const settingsPageExtensions = useMemo(
    () => extensions.filter((e) => e.settingsPage),
    [extensions],
  )

  if (!open) return null

  const q = query.trim().toLowerCase()
  const matchingExtensions = q ? extensions.filter((e) => extensionMatchesQuery(e, q)) : extensions
  const hitsIn = (id: string): number => (q ? (searchHits[id] ?? 0) : 0)
  const pageExtensions = q
    ? settingsPageExtensions.filter(
        (e) => extensionMatchesQuery(e, q) || hitsIn(extensionPageResultId(e.id)) > 0,
      )
    : settingsPageExtensions
  const shownPage =
    active === 'extensionPage' ? extensions.find((e) => e.id === pageExtId && e.settingsPage) : null
  const sandboxWorkspaces = workspaces
    .filter((w) => w.kind !== 'manager')
    .map((w) => ({ id: w.id, name: w.customName ?? w.name }))
  const matchingWorkspaces = q
    ? sandboxWorkspaces.filter((w) => w.name.toLowerCase().includes(q))
    : sandboxWorkspaces
  const visible = q
    ? sections.filter(
        (s) =>
          matchesQuery([s.label], q) ||
          hitsIn(s.id) > 0 ||
          (s.id === 'extensions' && (matchingExtensions.length > 0 || pageExtensions.length > 0)) ||
          (s.id === 'sandbox' && matchingWorkspaces.length > 0),
      )
    : sections
  const navExtensions = q ? matchingExtensions : extensions
  const extensionsChildrenShown = navExtensions.length > 0 && (q !== '' || extensionsExpanded)
  const extensionItems: NavChild[] = navExtensions.map((ext) => ({
    id: ext.id,
    label: ext.name,
    icon: ext.panel?.icon ? extensionIcon(ext.panel.icon) : null,
    current: active === 'extensions' && anchor?.id === ext.id,
  }))
  const sandboxItems: NavChild[] = [
    ...(q
      ? []
      : [
          {
            id: SANDBOX_DEFAULTS_ITEM,
            label: d.sandbox.defaults,
            icon: null,
            current: active === 'sandbox',
          },
        ]),
    ...matchingWorkspaces.map((w) => ({
      id: w.id,
      label: w.name,
      icon: null,
      current: active === 'workspace' && settingsWorkspaceId === w.id,
    })),
  ]
  const sandboxChildrenShown = q ? matchingWorkspaces.length > 0 : sandboxExpanded
  const inSandbox = active === 'sandbox' || active === 'workspace'

  return (
    <section
      aria-label={d.settings.title}
      className="absolute inset-0 z-20 flex min-h-0 flex-col bg-bg text-fg"
    >
      <div className="grid min-h-0 flex-1 grid-cols-[210px_1fr]">
        <nav ref={navRef} className="flex min-h-0 flex-col border-line border-r bg-surface-1">
          <InputGroup className="m-2 h-7 w-auto">
            <InputGroupAddon>
              <MagnifyingGlassIcon />
            </InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(e) => changeQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation()
                  changeQuery('')
                } else if ((e.key === 'Enter' || e.key === 'ArrowDown') && q) {
                  const control = firstMatchControl(contentRef.current)
                  if (!control) return
                  e.preventDefault()
                  control.focus()
                }
              }}
              placeholder={d.settings.search}
              aria-label={d.settings.search}
            />
          </InputGroup>
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-3 px-2 pb-2">
              {SETTINGS_GROUPS.map((group) => {
                const items = visible.filter((s) => s.group === group)
                if (items.length === 0) return null
                const headingId = `settings-nav-group-${group}`
                return (
                  <li key={group}>
                    <h3 id={headingId} className="px-2 pb-1 font-medium text-fg-muted text-ui-xs">
                      {d.settings.groups[group]}
                    </h3>
                    <ul aria-labelledby={headingId} className="flex flex-col gap-0.5">
                      {items.map((s) =>
                        s.id === 'extensions' ? (
                          <Fragment key={s.id}>
                            <NavDisclosure
                              label={s.label}
                              icon={s.icon}
                              current={active === 'extensions' && !anchor}
                              count={hitsIn(s.id)}
                              emphasized={active === 'extensions'}
                              items={extensionItems}
                              itemCurrent="location"
                              listId={EXTENSIONS_NAV_LIST_ID}
                              listLabel={d.settings.extensionsNavList}
                              expanded={extensionsChildrenShown}
                              canToggle={q === '' && extensions.length > 0}
                              buttonRef={extensionsButtonRef}
                              onOpen={() => openSection('extensions')}
                              onToggle={expandExtensions}
                              onOpenItem={openExtension}
                            />
                            {pageExtensions.map((ext) => (
                              <NavItem
                                key={`page-${ext.id}`}
                                label={pageTitle(ext)}
                                icon={extensionIcon(ext.settingsPage?.icon)}
                                current={shownPage?.id === ext.id}
                                count={hitsIn(extensionPageResultId(ext.id))}
                                onOpen={() => openExtensionPage(ext.id)}
                              />
                            ))}
                          </Fragment>
                        ) : s.id === 'sandbox' ? (
                          <NavDisclosure
                            key={s.id}
                            label={s.label}
                            icon={s.icon}
                            current={inSandbox && !sandboxChildrenShown}
                            count={hitsIn(s.id)}
                            emphasized={inSandbox}
                            items={sandboxItems}
                            itemCurrent="page"
                            listId={SANDBOX_NAV_LIST_ID}
                            listLabel={d.sandbox.navList}
                            expanded={sandboxChildrenShown}
                            canToggle={q === ''}
                            buttonRef={sandboxButtonRef}
                            onOpen={() => openSection('sandbox')}
                            onToggle={expandSandbox}
                            onOpenItem={openSandboxItem}
                          />
                        ) : (
                          <NavItem
                            key={s.id}
                            label={s.label}
                            icon={s.icon}
                            current={active === s.id}
                            count={hitsIn(s.id)}
                            onOpen={() => openSection(s.id)}
                          />
                        ),
                      )}
                    </ul>
                  </li>
                )
              })}
            </ul>
          </ScrollArea>
          <Button variant="outline" size="sm" onClick={openSettingsFile} className="m-2">
            <FileCodeIcon data-icon="inline-start" />
            {d.settings.openFile}
          </Button>
        </nav>

        <ScrollArea className="min-h-0">
          <div
            ref={contentRef}
            data-slot="settings-content"
            className="mx-auto max-w-3xl select-text px-8 py-5 [&_[data-slot=kbd]]:pointer-events-auto [&_[data-slot=kbd]]:select-text [&_[data-slot=label]]:select-text"
          >
            {q && visible.length === 0 ? (
              <p className="text-fg-muted text-ui-sm">{d.settings.noMatches}</p>
            ) : null}
            <SettingsPages
              searching={q !== ''}
              active={active}
              sections={sections}
              settingsPageExtensions={settingsPageExtensions}
              shownPage={shownPage ?? null}
              anchor={anchor}
              targetWorkspace={targetWorkspace}
              store={searchStore}
              onHits={onSearchHits}
            />
          </div>
        </ScrollArea>
      </div>
    </section>
  )
}

const SettingsPages = memo(function SettingsPages({
  searching,
  active,
  sections,
  settingsPageExtensions,
  shownPage,
  anchor,
  targetWorkspace,
  store,
  onHits,
}: {
  searching: boolean
  active: SectionId
  sections: { id: SectionId; label: string }[]
  settingsPageExtensions: ExtensionInfo[]
  shownPage: ExtensionInfo | null
  anchor: ExtensionAnchor | null
  targetWorkspace: Workspace | undefined
  store: SearchStore
  onHits: (id: string, hits: number) => void
}): JSX.Element {
  const page = (id: SectionId): React.ReactNode => (
    <>
      {id === 'appearance' ? <AppearanceSection /> : null}
      {id === 'terminal' ? <TerminalSection /> : null}
      {id === 'prompt' ? <PromptSection /> : null}
      {id === 'keyboard' ? (
        <>
          <KeyboardSection />
          <ActionsSection />
        </>
      ) : null}
      {id === 'panes' ? <PanesSection /> : null}
      {id === 'notifications' ? <NotificationsSection /> : null}
      {id === 'sidebar' ? <SidebarSection /> : null}
      {id === 'workspaces' ? <WorkspacesSection /> : null}
      {id === 'sandbox' ? <SandboxSection /> : null}
      {id === 'workspace' && targetWorkspace ? (
        <WorkspaceSandboxPage
          key={targetWorkspace.id}
          workspaceId={targetWorkspace.id}
          workspaceName={targetWorkspace.customName ?? targetWorkspace.name}
        />
      ) : null}
      {id === 'agents' ? <AgentsSection /> : null}
      {id === 'assistant' ? <AssistantSection /> : null}
      {id === 'manager' ? <ManagerSection /> : null}
      {id === 'files' ? <FilesSection /> : null}
      {id === 'git' ? <GitSection /> : null}
      {id === 'ports' ? <PortsSection /> : null}
      {id === 'browser' ? <BrowserSettingsSection /> : null}
      {id === 'passwords' ? <PasswordsSection /> : null}
      {id === 'privacy' ? <PrivacySection /> : null}
      {id === 'editor' ? <EditorSettingsSection /> : null}
      {id === 'extensions' || (id === 'extensionPage' && !shownPage) ? (
        <ExtensionsPage anchor={anchor} />
      ) : null}
      {id === 'browseExtensions' ? <BrowseExtensionsPage /> : null}
      {id === 'extensionPage' && shownPage ? (
        <ExtensionSettingsPage key={shownPage.id} ext={shownPage} />
      ) : null}
      {id === 'views' ? <ViewsSection /> : null}
      {id === 'languageServers' ? <LanguagesSection /> : null}
      {id === 'remote' ? <GatewaySection /> : null}
      {id === 'sync' ? <SyncSection /> : null}
      {id === 'language' ? <LanguageSection /> : null}
      {id === 'about' ? <AboutSection /> : null}
    </>
  )
  if (!searching) return <>{page(active)}</>
  return (
    <>
      {sections.map((s) => (
        <Fragment key={s.id}>
          <SettingsSearchSection id={s.id} label={s.label} store={store} onHits={onHits}>
            {page(s.id)}
          </SettingsSearchSection>
          {s.id === 'extensions'
            ? settingsPageExtensions.map((ext) => (
                <SettingsSearchSection
                  key={ext.id}
                  id={extensionPageResultId(ext.id)}
                  label={pageTitle(ext)}
                  store={store}
                  onHits={onHits}
                >
                  <ExtensionSettingsPage ext={ext} />
                </SettingsSearchSection>
              ))
            : null}
        </Fragment>
      ))}
    </>
  )
})

function NavCount({ count }: { count: number }): JSX.Element | null {
  if (count === 0) return null
  return (
    <span aria-hidden className="ml-auto text-fg-muted text-ui-xs tabular-nums">
      {count}
    </span>
  )
}

function NavItem({
  label,
  icon: ItemIcon,
  current,
  count,
  onOpen,
}: {
  label: string
  icon: IconComponent
  current: boolean
  count: number
  onOpen: () => void
}): JSX.Element {
  return (
    <li>
      <Button
        variant="ghost"
        onClick={onOpen}
        aria-current={current ? 'page' : undefined}
        className={cn(
          'w-full justify-start gap-2.5 font-normal text-ui-base',
          current ? 'bg-surface-2 text-fg' : 'text-fg-muted',
        )}
      >
        <ItemIcon className={current ? 'text-fg' : 'text-fg-muted'} />
        <span className="min-w-0 truncate">{label}</span>
        <NavCount count={count} />
      </Button>
    </li>
  )
}

function NavDisclosure({
  label,
  icon: SectionIcon,
  current,
  count,
  emphasized,
  items,
  itemCurrent,
  listId,
  listLabel,
  expanded,
  canToggle,
  buttonRef,
  onOpen,
  onToggle,
  onOpenItem,
}: {
  label: string
  icon: IconComponent
  current: boolean
  count: number
  emphasized: boolean
  items: NavChild[]
  itemCurrent: 'page' | 'location'
  listId: string
  listLabel: string
  expanded: boolean
  canToggle: boolean
  buttonRef: React.RefObject<HTMLButtonElement>
  onOpen: () => void
  onToggle: (expanded: boolean) => void
  onOpenItem: (id: string) => void
}): JSX.Element {
  return (
    <li>
      <div className={cn('flex items-center gap-0.5 rounded-lg', current && 'bg-surface-2')}>
        <Button
          ref={buttonRef}
          variant="ghost"
          onClick={onOpen}
          onKeyDown={(e) => {
            if (!canToggle) return
            if (e.key === 'ArrowRight' && !expanded) {
              e.preventDefault()
              onToggle(true)
            } else if (e.key === 'ArrowLeft' && expanded) {
              e.preventDefault()
              onToggle(false)
            }
          }}
          aria-current={current ? 'page' : undefined}
          className={cn(
            'min-w-0 flex-1 justify-start gap-2.5 font-normal text-ui-base',
            emphasized ? 'text-fg' : 'text-fg-muted',
          )}
        >
          <SectionIcon className={emphasized ? 'text-fg' : 'text-fg-muted'} />
          {label}
          <NavCount count={count} />
        </Button>
        {canToggle ? (
          <IconButton
            icon={CaretRightIcon}
            label={listLabel}
            aria-expanded={expanded}
            aria-controls={expanded ? listId : undefined}
            onClick={() => onToggle(!expanded)}
            className={cn('mr-1 [&_svg]:transition-transform', expanded && '[&_svg]:rotate-90')}
          />
        ) : null}
      </div>
      {expanded ? (
        <ul
          id={listId}
          aria-label={listLabel}
          className="mt-0.5 ml-4 flex flex-col gap-0.5 border-line border-l pl-1.5"
        >
          {items.map((item) => {
            const ItemIcon = item.icon
            return (
              <li key={item.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenItem(item.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault()
                      buttonRef.current?.focus()
                    }
                  }}
                  aria-current={item.current ? itemCurrent : undefined}
                  className={cn(
                    'w-full justify-start gap-2 font-normal text-ui-sm',
                    item.current ? 'bg-surface-2 text-fg' : 'text-fg-muted',
                  )}
                >
                  {ItemIcon ? (
                    <ItemIcon className={item.current ? 'text-fg' : 'text-fg-muted'} />
                  ) : (
                    <span aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">{item.label}</span>
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </li>
  )
}

export function SectionHead({ title, desc }: { title: string; desc?: string }): JSX.Element {
  useSearchLeaf([title, desc])
  return (
    <>
      <h2 className="mb-1.5 font-semibold text-fg text-ui-lg">
        <Highlight text={title} />
      </h2>
      {desc ? (
        <p className="mb-3 text-fg-muted text-ui-sm">
          <Highlight text={desc} />
        </p>
      ) : null}
    </>
  )
}

export function SettingsGroup({
  title,
  desc,
  action,
  children,
}: {
  title: string
  desc?: string
  action?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  const search = useSearchGroup([title, desc])
  return (
    <section
      hidden={search.hidden}
      className="mt-5 border-line border-t pt-5 first-of-type:mt-3 first-of-type:border-t-0 first-of-type:pt-0"
    >
      <div className="mb-2 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="font-semibold text-fg text-ui-emphasis">
            <Highlight text={title} />
          </h3>
          {desc ? (
            <p className="mt-0.5 text-fg-muted text-ui-sm">
              <Highlight text={desc} />
            </p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <SearchScopeProvider value={search.scope}>{children}</SearchScopeProvider>
    </section>
  )
}

export function SubHead({ title, desc }: { title: string; desc?: string }): JSX.Element {
  useSearchLeaf([title, desc])
  return (
    <div className="mb-2">
      <h3 className="font-medium text-fg text-ui-base">
        <Highlight text={title} />
      </h3>
      {desc ? (
        <p className="mt-0.5 text-fg-muted text-ui-sm">
          <Highlight text={desc} />
        </p>
      ) : null}
    </div>
  )
}

export function WarningNote({
  children,
  actions,
}: {
  children: React.ReactNode
  actions?: React.ReactNode
}): JSX.Element {
  return (
    <Alert
      className={cn(
        'mt-1 items-center rounded-none border-0 bg-transparent p-0 text-warn-fg has-data-[slot=alert-action]:pr-0',
        actions ? 'has-[>svg]:grid-cols-[auto_1fr_auto]' : null,
      )}
    >
      <WarningIcon className="size-3.5" />
      <AlertDescription className="text-warn-fg text-ui-sm [&_p:not(:last-child)]:mb-1">
        {children}
      </AlertDescription>
      {actions ? (
        <AlertAction className="static flex items-center gap-1">{actions}</AlertAction>
      ) : null}
    </Alert>
  )
}

export function ControlRow({
  label,
  desc,
  error,
  errorId,
  labelHint,
  below,
  children,
}: {
  label: string
  desc?: string
  error?: string | null
  errorId?: string
  labelHint?: React.ReactNode
  below?: React.ReactNode
  children?: React.ReactNode
}): JSX.Element {
  const search = useSearchRow([label, desc])
  return (
    <div
      data-settings-row
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      className={`flex justify-between gap-6 py-1.5 ${desc || error || below ? 'items-start' : 'items-center'}`}
    >
      <div className="min-w-0">
        {labelHint ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-fg text-ui-base">
              <Highlight text={label} />
            </span>
            {labelHint}
          </div>
        ) : (
          <div className="text-fg text-ui-base">
            <Highlight text={label} />
          </div>
        )}
        {desc ? (
          <p className="mt-0.5 text-fg-muted text-ui-sm">
            <Highlight text={desc} />
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="mt-0.5 text-attn-fg text-ui-sm">
            {error}
          </p>
        ) : null}
        {below ? <div className="mt-1.5">{below}</div> : null}
      </div>
      {children ? (
        <div className="flex shrink-0 items-center gap-2">
          <SearchScopeProvider value={search.scope}>{children}</SearchScopeProvider>
        </div>
      ) : null}
    </div>
  )
}

export function SelectField<T extends string>({
  value,
  onChange,
  options,
  label,
  width = 'w-fit min-w-44 max-w-80',
  disabled,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
  width?: string
  disabled?: boolean
}): JSX.Element {
  const current = options.find((o) => o.value === value)?.label ?? value
  useSearchLeaf(options.map((o) => o.label))
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" aria-label={label} className={width} disabled={disabled}>
        <span className="min-w-0 truncate">
          <Highlight text={current} />
        </span>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ExperimentalBadge(): JSX.Element {
  const d = useDict()
  return (
    <Badge variant="outline" className="h-4 px-1 text-ui-xs tracking-caps">
      {d.settings.experimental}
    </Badge>
  )
}

export function ToggleRow({
  label,
  desc,
  checked,
  onChange,
  disabled,
  labelHint,
  below,
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  labelHint?: React.ReactNode
  below?: React.ReactNode
}): JSX.Element {
  return (
    <ControlRow label={label} desc={desc} labelHint={labelHint} below={below}>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} disabled={disabled} />
    </ControlRow>
  )
}

function AppearanceSection(): JSX.Element {
  const d = useDict()
  const motion = useSettingsStore((s) => s.appearance.motion)
  const setMotion = useSettingsStore((s) => s.setMotion)
  const motionLabel: Record<MotionMode, string> = {
    system: d.settings.motionSystem,
    reduced: d.settings.motionReduced,
    full: d.settings.motionFull,
  }
  return (
    <div>
      <SectionHead title={d.settings.appearance} />
      <SettingsGroup title={d.settings.groupTheme}>
        <ThemeRows />
        <ControlRow label={d.settings.motion} desc={d.settings.motionDesc}>
          <SelectField
            value={motionMode(motion)}
            onChange={setMotion}
            label={d.settings.motion}
            options={MOTION_MODES.map((m) => ({ value: m, label: motionLabel[m] }))}
          />
        </ControlRow>
        <AccentRow />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupDisplay}>
        <ZoomRow />
        <WindowTitleRow />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupFonts}>
        <FontRow surface="ui" label={d.settings.uiFont} desc={d.settings.uiFontDesc} />
        <FontRow surface="terminal" label={d.settings.terminalFont} />
        <LineHeightRow />
        <FontRow surface="editor" label={d.settings.editorFont} desc={d.settings.editorFontDesc} />
      </SettingsGroup>
    </div>
  )
}

function WindowTitleRow(): JSX.Element {
  const d = useDict()
  const template = useSettingsStore((s) => s.appearance.windowTitle)
  const setWindowTitle = useSettingsStore((s) => s.setWindowTitle)
  const [draft, setDraft] = useState(template)
  useEffect(() => setDraft(template), [template])
  const commit = (): void => {
    if (draft !== template) setWindowTitle(draft)
  }
  return (
    <ControlRow
      label={d.settings.windowTitle}
      desc={fmt(d.settings.windowTitleDesc, { productPlaceholder: PRODUCT_PLACEHOLDER })}
    >
      <Input
        value={draft}
        spellCheck={false}
        maxLength={WINDOW_TITLE_MAX}
        aria-label={d.settings.windowTitle}
        className="h-7 w-56 font-mono text-ui-sm"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
    </ControlRow>
  )
}

const FULL_HEX = /^#[0-9a-f]{6}$/i

function AccentRow(): JSX.Element {
  const d = useDict()
  const accent = useSettingsStore((s) => s.appearance.accent)
  const setAccent = useSettingsStore((s) => s.setAccent)
  const [draft, setDraft] = useState(accent)
  useEffect(() => setDraft(accent), [accent])
  const invalid = draft.trim() !== '' && normalizeHex(draft) === null
  const custom = accent !== '' && !ACCENT_PRESETS.includes(accent)
  const themeBrand = normalizeHex(useEffectiveTheme()?.tokens.brand) ?? ACCENT_PRESETS[0]
  return (
    <ControlRow
      label={d.settings.accent}
      desc={d.settings.accentDesc}
      error={invalid ? d.settings.accentInvalid : null}
      errorId="accent-hex-error"
    >
      <div className="flex items-center gap-1.5">
        {ACCENT_PRESETS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={fmt(d.settings.accentPreset, { color })}
            aria-pressed={accent === color}
            onClick={() => setAccent(color)}
            style={{ background: color }}
            className="size-5 rounded-full border border-line-strong outline-offset-2 focus-visible:outline-2 focus-visible:outline-brand aria-pressed:outline-2 aria-pressed:outline-fg"
          />
        ))}
        <Hint label={d.settings.accentCustom}>
          <label
            data-testid="accent-custom"
            data-selected={custom || undefined}
            style={custom ? { background: accent } : undefined}
            className={cn(
              'relative flex size-5 items-center justify-center rounded-full border outline-offset-2 has-focus-visible:outline-2 has-focus-visible:outline-brand',
              custom
                ? 'border-line-strong outline-2 outline-fg'
                : 'border-line-strong border-dashed text-fg-muted hover:text-fg',
            )}
          >
            {custom ? null : <PlusIcon size={12} aria-hidden />}
            <input
              type="color"
              aria-label={d.settings.accentCustom}
              value={custom ? accent : themeBrand}
              onChange={(e) => setAccent(e.target.value)}
              className="absolute inset-0 size-full opacity-0"
            />
          </label>
        </Hint>
      </div>
      <Input
        value={draft}
        spellCheck={false}
        placeholder="#rrggbb"
        aria-label={d.settings.accentHex}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'accent-hex-error' : undefined}
        onChange={(e) => {
          setDraft(e.target.value)
          if (FULL_HEX.test(e.target.value.trim())) setAccent(e.target.value)
        }}
        onBlur={() => {
          if (!setAccent(draft)) setDraft(accent)
        }}
        className="h-7 w-24 font-mono"
      />
      <Button variant="ghost" size="sm" disabled={accent === ''} onClick={() => setAccent('')}>
        {d.settings.accentReset}
      </Button>
    </ControlRow>
  )
}

function ZoomRow(): JSX.Element {
  const d = useDict()
  const zoom = useSettingsStore((s) => s.appearance.zoom)
  const setZoom = useSettingsStore((s) => s.setZoom)
  const [draft, setDraft] = useState(String(zoom))
  useEffect(() => setDraft(String(zoom)), [zoom])
  const commit = (): void => {
    const n = Number(draft)
    if (Number.isFinite(n) && draft.trim() !== '') setZoom(n)
    else setDraft(String(zoom))
  }
  return (
    <ControlRow label={d.settings.zoom} desc={d.settings.zoomDesc}>
      <Input
        type="number"
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={draft}
        aria-label={d.settings.zoom}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className="h-7 w-20 font-mono"
      />
      <span className="text-fg-muted text-ui-sm">%</span>
    </ControlRow>
  )
}

function FontRow({
  surface,
  label,
  desc,
}: {
  surface: FontSurface
  label: string
  desc?: string
}): JSX.Element {
  const d = useDict()
  const font = useSettingsStore((s) => s.appearance[surface])
  const setSurfaceFont = useSettingsStore((s) => s.setSurfaceFont)
  return (
    <ControlRow label={label} desc={desc}>
      <FontPicker
        value={font.family}
        label={fmt(d.settings.fontFamilyFor, { label })}
        onChange={(family) => setSurfaceFont(surface, { family })}
      />
      <SelectField
        value={String(font.weight)}
        onChange={(w) => setSurfaceFont(surface, { weight: Number(w) })}
        label={fmt(d.settings.fontWeightFor, { label })}
        width="w-20"
        options={FONT_WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))}
      />
      <Input
        type="number"
        min={8}
        max={32}
        value={font.size}
        aria-label={fmt(d.settings.fontSizeFor, { label })}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n > 0) {
            setSurfaceFont(surface, { size: Math.min(32, Math.max(8, Math.round(n))) })
          }
        }}
        className="h-7 w-16 font-mono"
      />
    </ControlRow>
  )
}

function LineHeightRow(): JSX.Element {
  const d = useDict()
  const lineHeight = useSettingsStore((s) => s.appearance.terminal.lineHeight)
  const setLineHeight = useSettingsStore((s) => s.setTerminalLineHeight)
  return (
    <ControlRow label={d.settings.lineHeight} desc={d.settings.lineHeightDesc}>
      <Input
        type="number"
        min={LINE_HEIGHT_MIN}
        max={LINE_HEIGHT_MAX}
        step={0.05}
        value={lineHeight}
        aria-label={d.settings.lineHeight}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n > 0) setLineHeight(n)
        }}
        className="h-7 w-20 font-mono"
      />
    </ControlRow>
  )
}

function NotificationsSection(): JSX.Element {
  const d = useDict()
  const n = useSettingsStore((s) => s.notifications)
  const set = useSettingsStore((s) => s.setNotifications)
  const bellLabel: Record<BellMode, string> = {
    attention: d.settings.bellAttention,
    sound: d.settings.bellSound,
    off: d.settings.bellOff,
  }
  return (
    <div>
      <SectionHead title={d.settings.notifications} />
      <SettingsGroup title={d.settings.groupDesktop}>
        <ToggleRow
          label={d.settings.notifyDesktop}
          desc={d.settings.notifyDesktopDesc}
          checked={n.desktop}
          onChange={(v) => set({ desktop: v })}
        />
        <ToggleRow
          label={d.settings.notifySound}
          desc={d.settings.notifySoundDesc}
          checked={n.sound}
          onChange={(v) => set({ sound: v })}
        />
        <ToggleRow
          label={d.settings.notifyWhenFocused}
          desc={d.settings.notifyWhenFocusedDesc}
          checked={n.whenFocused}
          onChange={(v) => set({ whenFocused: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupCommand}>
        <ControlRow label={d.settings.notifyCommand} desc={d.settings.notifyCommandDesc}>
          <Input
            value={n.command}
            spellCheck={false}
            aria-label={d.settings.notifyCommand}
            onChange={(e) => set({ command: e.target.value })}
            className="h-7 w-56 font-mono"
          />
        </ControlRow>
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupEvents}>
        <ToggleRow
          label={d.settings.notifyAgentWaiting}
          desc={d.settings.notifyAgentWaitingDesc}
          checked={n.agentWaiting}
          onChange={(v) => set({ agentWaiting: v })}
        />
        <ToggleRow
          label={d.settings.notifyAgentDone}
          desc={d.settings.notifyAgentDoneDesc}
          checked={n.agentDone}
          onChange={(v) => set({ agentDone: v })}
        />
        <ToggleRow
          label={d.settings.notifyCommandFinished}
          desc={d.settings.notifyCommandFinishedDesc}
          checked={n.commandFinished}
          onChange={(v) => set({ commandFinished: v })}
        />
        <NumberRow
          label={d.settings.longCommandSeconds}
          desc={d.settings.longCommandSecondsDesc}
          value={n.longCommandSeconds}
          min={LONG_COMMAND_MIN_SECONDS}
          max={LONG_COMMAND_MAX_SECONDS}
          onCommit={(v) => set({ longCommandSeconds: clampLongCommandSeconds(v) })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupBell}>
        <ControlRow label={d.settings.bell} desc={d.settings.bellDesc}>
          <SelectField
            value={n.bell}
            onChange={(v) => set({ bell: v })}
            label={d.settings.bell}
            options={BELL_MODES.map((m) => ({ value: m, label: bellLabel[m] }))}
          />
        </ControlRow>
      </SettingsGroup>
    </div>
  )
}

function SidebarSection(): JSX.Element {
  const d = useDict()
  const sidebar = useSettingsStore((s) => s.sidebar)
  const set = useSettingsStore((s) => s.setSidebar)
  return (
    <div>
      <SectionHead title={d.settings.sidebar} />
      <SettingsGroup title={d.settings.groupRows}>
        <ToggleRow
          label={d.settings.sidebarPath}
          desc={d.settings.sidebarPathDesc}
          checked={sidebar.showPath}
          onChange={(v) => set({ showPath: v })}
        />
        <ToggleRow
          label={d.settings.sidebarMessage}
          desc={d.settings.sidebarMessageDesc}
          checked={sidebar.showMessage}
          onChange={(v) => set({ showMessage: v })}
        />
        <ToggleRow
          label={d.settings.sidebarDescription}
          desc={d.settings.sidebarDescriptionDesc}
          checked={sidebar.showDescription}
          onChange={(v) => set({ showDescription: v })}
        />
        <ToggleRow
          label={d.settings.sidebarItems}
          desc={d.settings.sidebarItemsDesc}
          checked={sidebar.showExtensionItems}
          onChange={(v) => set({ showExtensionItems: v })}
        />
        <ToggleRow
          label={d.settings.sidebarSsh}
          desc={d.settings.sidebarSshDesc}
          checked={sidebar.showSSH}
          onChange={(v) => set({ showSSH: v })}
        />
      </SettingsGroup>
    </div>
  )
}

export function NumberRow({
  label,
  desc,
  value,
  min,
  max,
  onCommit,
}: {
  label: string
  desc: string
  value: number
  min: number
  max: number
  onCommit: (n: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const n = Number(draft)
    if (draft.trim() && Number.isFinite(n)) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <ControlRow label={label} desc={desc}>
      <Input
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        value={draft}
        aria-label={label}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
        className="h-7 w-24 font-mono"
      />
    </ControlRow>
  )
}

const NO_GRANTS: readonly Capability[] = []

function AlwaysAllowedGroup(): JSX.Element {
  const d = useDict()
  const caps = useSettingsStore((s) => s.capabilities?.grants ?? NO_GRANTS)
  return (
    <SettingsGroup title={d.approvals.always} desc={d.approvals.alwaysDesc}>
      {caps.length === 0 ? (
        <p className="py-1.5 text-fg-muted text-ui-sm">{d.approvals.alwaysNone}</p>
      ) : (
        caps.map((cap) => (
          <ControlRow key={cap} label={capLabel(d.approvals.caps, cap)}>
            <Button
              variant="outline"
              size="xs"
              onClick={() => void window.ostia.approvals.removeAlways(cap)}
            >
              {d.approvals.alwaysRemove}
            </Button>
          </ControlRow>
        ))
      )}
    </SettingsGroup>
  )
}

function ReachGroup(): JSX.Element {
  const d = useDict()
  const reach = useSettingsStore((s) => parseReachMode(s.capabilities?.reach))
  const label: Record<ReachMode, string> = {
    workspace: d.approvals.reachWorkspace,
    project: d.approvals.reachProject,
    group: d.approvals.reachGroup,
  }
  const explain: Record<ReachMode, string> = {
    workspace: d.approvals.reachWorkspaceDesc,
    project: d.approvals.reachProjectDesc,
    group: d.approvals.reachGroupDesc,
  }
  return (
    <SettingsGroup title={d.approvals.reach} desc={d.approvals.reachDesc}>
      <ControlRow label={d.approvals.reach} desc={explain[reach]}>
        <SelectField
          value={reach}
          onChange={(mode) => void window.ostia.approvals.setReach(mode)}
          label={d.approvals.reach}
          options={REACH_MODES.map((mode) => ({ value: mode, label: label[mode] }))}
        />
      </ControlRow>
    </SettingsGroup>
  )
}

function AgentsSection(): JSX.Element {
  const d = useDict()
  const hibernation = useSettingsStore((s) => s.agents.hibernation)
  const set = useSettingsStore((s) => s.setHibernation)
  const autoResume = useSettingsStore((s) => s.agents.autoResume)
  const setAutoResume = useSettingsStore((s) => s.setAutoResume)
  const autoSendReferences = useSettingsStore((s) => s.agents.autoSendReferences)
  const setAutoSendReferences = useSettingsStore((s) => s.setAutoSendReferences)
  const hooks = useSettingsStore((s) => s.agents.hooks)
  const setAgentHooks = useSettingsStore((s) => s.setAgentHooks)
  const approvalMode = useSettingsStore((s) => s.approvals.mode)
  const setApprovalMode = useSettingsStore((s) => s.setApprovalMode)
  return (
    <div>
      <SectionHead title={d.settings.agents} />
      <SettingsGroup title={d.approvals.inbox}>
        <ControlRow label={d.approvals.mode} desc={d.approvals.modeDesc}>
          <SelectField
            value={approvalMode}
            onChange={(mode) => setApprovalMode(mode as ApprovalMode)}
            label={d.approvals.mode}
            options={[
              { value: 'ask', label: d.approvals.modeAsk },
              { value: 'allow', label: d.approvals.modeAllow },
            ]}
          />
        </ControlRow>
      </SettingsGroup>
      <ReachGroup />
      <AlwaysAllowedGroup />
      <SettingsGroup title={d.settings.groupResume}>
        <ToggleRow
          label={d.settings.autoResume}
          desc={d.settings.autoResumeDesc}
          checked={autoResume}
          onChange={setAutoResume}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupReferences}>
        <ToggleRow
          label={d.settings.autoSendReferences}
          desc={d.settings.autoSendReferencesDesc}
          checked={autoSendReferences}
          onChange={setAutoSendReferences}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupAgentHooks}>
        <ToggleRow
          label={d.settings.claudeHooks}
          desc={d.settings.claudeHooksDesc}
          checked={hooks.claude}
          onChange={(v) => setAgentHooks({ claude: v })}
        />
        <ToggleRow
          label={d.settings.codexHooks}
          desc={d.settings.codexHooksDesc}
          checked={hooks.codex}
          onChange={(v) => setAgentHooks({ codex: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPerformance}>
        <ToggleRow
          label={d.settings.hibernate}
          desc={d.settings.hibernateDesc}
          checked={hibernation.enabled}
          onChange={(v) => set({ enabled: v })}
        />
        {hibernation.enabled ? (
          <>
            <NumberRow
              label={d.settings.hibernateIdle}
              desc={d.settings.hibernateIdleDesc}
              value={hibernation.idleSeconds}
              min={HIBERNATION_IDLE_MIN}
              max={HIBERNATION_IDLE_MAX}
              onCommit={(n) => set({ idleSeconds: n })}
            />
            <NumberRow
              label={d.settings.hibernateMaxLive}
              desc={d.settings.hibernateMaxLiveDesc}
              value={hibernation.maxLiveTerminals}
              min={0}
              max={HIBERNATION_LIVE_MAX}
              onCommit={(n) => set({ maxLiveTerminals: n })}
            />
            <WarningNote>{d.settings.hibernateNote}</WarningNote>
          </>
        ) : null}
      </SettingsGroup>
    </div>
  )
}

function TerminalSection(): JSX.Element {
  const d = useDict()
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)
  const restoreWorkspace = useSettingsStore((s) => s.behavior.restoreWorkspace)
  const gpuAcceleration = useSettingsStore((s) => s.behavior.gpuAcceleration)
  const copyOnSelect = useSettingsStore((s) => s.behavior.copyOnSelect)
  const wheelZoom = useSettingsStore((s) => s.behavior.wheelZoom)
  const mode = useSettingsStore((s) => s.behavior.inputMode)
  const vim = useSettingsStore((s) => s.behavior.inputEditorVim)
  const historySuggestions = useSettingsStore((s) => s.behavior.historySuggestions)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const scrollSpeed = useSettingsStore((s) => s.terminal.scrollSpeed)
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines)
  const warnOnRiskyPaste = useSettingsStore((s) => s.terminal.warnOnRiskyPaste)
  const clipboardKeys = useSettingsStore((s) => s.terminal.clipboardKeys)
  const minimumContrast = useSettingsStore((s) => s.terminal.minimumContrast)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const promptStyle = useSettingsStore((s) => s.terminal.prompt.style)
  const shell = useSettingsStore((s) => s.terminal.shell)
  const osc52Write = useSettingsStore((s) => s.terminal.osc52Write)
  const keepShells = useSettingsStore((s) => s.terminal.keepShells)
  const renderer = useSettingsStore((s) => s.terminal.renderer)
  const keepShellsRequirements = useRequirements(KEEP_SHELLS_FEATURE)
  const keepShellsReport = keepShellsRequirements.report
  const primarySelection = useSettingsStore((s) => s.terminal.primarySelection)
  const macOptionIsMeta = useSettingsStore((s) => s.terminal.macOptionIsMeta)
  const modeLabel: Record<InputMode, string> = {
    terminal: d.settings.inputModeTerminal,
    editor: d.settings.inputModeEditor,
  }
  const rendererLabel: Record<TerminalRenderer, string> = {
    xterm: d.settings.rendererXterm,
    ghostty: d.settings.rendererGhostty,
  }
  const styleLabel: Record<CursorStyle, string> = {
    block: d.settings.styleBlock,
    underline: d.settings.styleUnderline,
    bar: d.settings.styleBar,
  }
  return (
    <div>
      <SectionHead title={d.settings.terminal} />
      <SettingsGroup title={d.settings.groupInput}>
        <ControlRow label={d.settings.inputMode} desc={d.settings.inputModeDesc}>
          <SelectField
            value={mode}
            onChange={(m) => setBehavior({ inputMode: m })}
            label={d.settings.inputMode}
            options={INPUT_MODES.map((m) => ({ value: m, label: modeLabel[m] }))}
          />
        </ControlRow>
        <ToggleRow
          label={d.settings.inputEditorVim}
          desc={d.settings.inputEditorVimDesc}
          checked={vim}
          onChange={(v) => setBehavior({ inputEditorVim: v })}
        />
        <ToggleRow
          label={d.settings.historySuggestions}
          desc={d.settings.historySuggestionsDesc}
          checked={historySuggestions}
          onChange={(v) => setBehavior({ historySuggestions: v })}
        />
        <ControlRow
          label={d.prompt.title}
          below={
            <TextLink
              size="xs"
              className="h-auto p-0 font-normal text-ui-sm"
              onClick={() => useUIStore.getState().openSettings('prompt')}
            >
              {d.settings.promptOpen}
              <CaretRightIcon data-icon="inline-end" />
            </TextLink>
          }
        >
          <span className="text-fg-muted text-ui-sm">
            {promptStyle === 'ostia' ? d.settings.promptStylePine : d.settings.promptStyleShell}
          </span>
        </ControlRow>
        {promptStyle === 'ostia' && mode !== 'editor' ? (
          <WarningNote>{d.settings.promptNeedsEditor}</WarningNote>
        ) : null}
      </SettingsGroup>
      {isMac ? (
        <SettingsGroup title={d.settings.groupKeyboard}>
          <ToggleRow
            label={d.settings.macOptionIsMeta}
            desc={d.settings.macOptionIsMetaDesc}
            checked={macOptionIsMeta}
            onChange={(v) => setTerminal({ macOptionIsMeta: v })}
          />
        </SettingsGroup>
      ) : null}
      <SettingsGroup title={d.settings.groupCursor}>
        <ControlRow label={d.settings.cursorStyle}>
          <SelectField
            value={cursorStyle}
            onChange={(c) => setBehavior({ cursorStyle: c })}
            label={d.settings.cursorStyle}
            options={CURSOR_STYLES.map((c) => ({ value: c, label: styleLabel[c] }))}
          />
        </ControlRow>
        <ToggleRow
          label={d.settings.cursorBlink}
          desc={d.settings.cursorBlinkDesc}
          checked={cursorBlink}
          onChange={(v) => setBehavior({ cursorBlink: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupSelection}>
        <ToggleRow
          label={d.settings.copyOnSelect}
          desc={d.settings.copyOnSelectDesc}
          checked={copyOnSelect}
          onChange={(v) => setBehavior({ copyOnSelect: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupScrolling}>
        <ToggleRow
          label={isMac ? d.settings.wheelZoomMac : d.settings.wheelZoom}
          desc={d.settings.wheelZoomDesc}
          checked={wheelZoom}
          onChange={(v) => setBehavior({ wheelZoom: v })}
        />
        <StepNumberRow
          label={d.settings.scrollSpeed}
          desc={d.settings.scrollSpeedDesc}
          value={scrollSpeed}
          min={SCROLL_SPEED_MIN}
          max={SCROLL_SPEED_MAX}
          step={0.1}
          onCommit={(v) => setTerminal({ scrollSpeed: v })}
        />
        <StepNumberRow
          label={d.settings.scrollbackLines}
          desc={d.settings.scrollbackLinesDesc}
          value={scrollbackLines}
          min={SCROLLBACK_MIN}
          max={SCROLLBACK_MAX}
          step={1000}
          onCommit={(v) => setTerminal({ scrollbackLines: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPaste}>
        {isMac ? null : (
          <ControlRow label={d.settings.clipboardKeys} desc={d.settings.clipboardKeysDesc}>
            <SelectField
              value={clipboardKeys}
              onChange={(v) => setTerminal({ clipboardKeys: v as ClipboardKeys })}
              label={d.settings.clipboardKeys}
              options={[
                { value: 'shift', label: d.settings.clipboardShift },
                { value: 'smart', label: d.settings.clipboardSmart },
              ]}
            />
          </ControlRow>
        )}
        <ToggleRow
          label={d.settings.warnRiskyPaste}
          desc={d.settings.warnRiskyPasteDesc}
          checked={warnOnRiskyPaste}
          onChange={(v) => setTerminal({ warnOnRiskyPaste: v })}
        />
        <ToggleRow
          label={d.settings.osc52Write}
          desc={d.settings.osc52WriteDesc}
          checked={osc52Write}
          onChange={(v) => setTerminal({ osc52Write: v })}
        />
        {isLinux ? (
          <ToggleRow
            label={d.settings.primarySelection}
            desc={d.settings.primarySelectionDesc}
            checked={primarySelection}
            onChange={(v) => setTerminal({ primarySelection: v })}
          />
        ) : null}
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupColors}>
        <StepNumberRow
          label={d.settings.minimumContrast}
          desc={d.settings.minimumContrastDesc}
          value={minimumContrast}
          min={CONTRAST_MIN}
          max={CONTRAST_MAX}
          step={0.5}
          onCommit={(v) => setTerminal({ minimumContrast: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupRendering}>
        <ToggleRow
          label={d.settings.gpuAcceleration}
          desc={d.settings.gpuAccelerationDesc}
          checked={gpuAcceleration}
          onChange={(v) => setBehavior({ gpuAcceleration: v })}
        />
        {isLinux ? <DiscreteGpuRow /> : null}
        <ControlRow
          label={d.settings.terminalRenderer}
          desc={d.settings.terminalRendererDesc}
          labelHint={<ExperimentalBadge />}
        >
          <SelectField
            value={renderer}
            onChange={(r) => setTerminal({ renderer: r })}
            label={d.settings.terminalRenderer}
            options={TERMINAL_RENDERERS.map((r) => ({ value: r, label: rendererLabel[r] }))}
          />
        </ControlRow>
        {renderer === 'ghostty' && ghosttyFailure() ? (
          <WarningNote>
            {fmt(d.settings.ghosttyFailed, { reason: ghosttyFailure() ?? '' })}
          </WarningNote>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupSession}>
        <ToggleRow
          label={d.settings.restoreWorkspace}
          desc={d.settings.restoreWorkspaceDesc}
          checked={restoreWorkspace}
          onChange={(v) => setBehavior({ restoreWorkspace: v })}
        />
        <ControlRow label={d.settings.shell} desc={d.settings.shellDesc}>
          <Input
            value={shell}
            spellCheck={false}
            placeholder="$SHELL"
            aria-label={d.settings.shell}
            onChange={(e) => setTerminal({ shell: e.target.value })}
            className="h-7 w-56 font-mono"
          />
        </ControlRow>
        <ToggleRow
          label={d.settings.keepShells}
          desc={d.settings.keepShellsDesc}
          checked={keepShells}
          labelHint={<ExperimentalBadge />}
          disabled={!keepShells && (!keepShellsReport || keepShellsReport.missing.length > 0)}
          onChange={(v) => setTerminal({ keepShells: v })}
        />
        <RequirementsNoteView
          body={fmt(d.settings.keepShellsRequirementsBody, { version: TMUX_MIN_VERSION })}
          requirements={keepShellsRequirements}
        />
      </SettingsGroup>
    </div>
  )
}

function StepNumberRow({
  label,
  desc,
  value,
  min,
  max,
  step,
  onCommit,
}: {
  label: string
  desc: string
  value: number
  min: number
  max: number
  step: number
  onCommit: (v: number) => void
}): JSX.Element {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  return (
    <ControlRow label={label} desc={desc}>
      <Input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        aria-label={label}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = e.target.value.trim() === '' ? Number.NaN : Number(e.target.value)
          if (Number.isFinite(n) && n >= min && n <= max) onCommit(n)
        }}
        onBlur={() => setDraft(String(value))}
        className="h-7 w-24 font-mono"
      />
    </ControlRow>
  )
}

function PanesSection(): JSX.Element {
  const d = useDict()
  const panes = useSettingsStore((s) => s.panes)
  const set = useSettingsStore((s) => s.setPanes)
  return (
    <div>
      <SectionHead title={d.settings.panes} />
      <SettingsGroup title={d.settings.groupPaneFocus}>
        <ToggleRow
          label={d.settings.dimInactive}
          desc={d.settings.dimInactiveDesc}
          checked={panes.dimInactive}
          onChange={(v) => set({ dimInactive: v })}
        />
        <ToggleRow
          label={d.settings.focusOnHover}
          desc={d.settings.focusOnHoverDesc}
          checked={panes.focusOnHover}
          onChange={(v) => set({ focusOnHover: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPaneLayout}>
        <ToggleRow
          label={d.settings.equalizeOnSplit}
          desc={d.settings.equalizeOnSplitDesc}
          checked={panes.equalizeOnSplit}
          onChange={(v) => set({ equalizeOnSplit: v })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupPaneTabs}>
        <ToggleRow
          label={d.settings.hideTabClose}
          desc={d.settings.hideTabCloseDesc}
          checked={panes.hideTabClose}
          onChange={(v) => set({ hideTabClose: v })}
        />
      </SettingsGroup>
    </div>
  )
}

function FilesSection(): JSX.Element {
  const d = useDict()
  return (
    <section>
      <SectionHead title={d.settings.files} />
      <ExternalEditorRow />
      <FileTreeSettingsGroups />
    </section>
  )
}

function ExternalEditorRow(): JSX.Element {
  const d = useDict()
  const value = useSettingsStore((s) => s.behavior.externalEditor)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  return (
    <ControlRow label={d.settings.externalEditor} desc={d.settings.externalEditorDesc}>
      <Input
        value={value}
        spellCheck={false}
        aria-label={d.settings.externalEditor}
        onChange={(e) => setBehavior({ externalEditor: e.target.value })}
        className="h-7 w-56 font-mono"
      />
    </ControlRow>
  )
}

function ExtensionsPage({ anchor }: { anchor: ExtensionAnchor | null }): JSX.Element {
  const d = useDict()
  return (
    <section>
      <SectionHead title={d.settings.extensions} />
      <ExtensionsSection anchor={anchor} />
    </section>
  )
}

function BrowseExtensionsPage(): JSX.Element | null {
  const search = useSettingsSearch()
  if (search && !search.forced) return null
  return <BrowseExtensions />
}

function pageTitle(ext: ExtensionInfo): string {
  return withProductName(ext.settingsPage?.title ?? ext.name)
}

function extensionPageResultId(extId: string): string {
  return `extension-page:${extId}`
}

function ExtensionSettingsPage({ ext }: { ext: ExtensionInfo }): JSX.Element {
  const d = useDict()
  const title = pageTitle(ext)
  return (
    <section aria-label={title}>
      <SectionHead title={title} desc={fmt(d.extensions.settingsPageFrom, { name: ext.name })} />
      <ExtensionSettingsForm ext={ext} bare />
    </section>
  )
}

const PLATFORM_NAMES: Record<Platform, string> = {
  linux: 'Linux',
  darwin: 'macOS',
  win32: 'Windows',
}

function LanguageSection(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const setLocale = useSettingsStore((s) => s.setLocale)
  const languages = usePluginsStore((s) => s.languages)
  return (
    <section>
      <SectionHead title={d.settings.language} />
      <ControlRow label={d.settings.displayLanguage}>
        <SelectField
          value={locale}
          onChange={(l) => setLocale(l as Locale)}
          label={d.settings.displayLanguage}
          options={languages.map((l) => ({ value: l.id, label: l.label }))}
        />
      </ControlRow>
    </section>
  )
}

function AboutSection(): JSX.Element {
  const d = useDict()
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    window.ostia
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const name = info?.name ?? PRODUCT_DISPLAY_NAME
  const version = info ? `v${info.version}` : '…'
  return (
    <section
      aria-label={d.settings.about}
      className="flex flex-col items-center gap-3 pt-16 text-center"
    >
      <img src={appIcon} alt="" className="size-20" />
      <h2 className="font-semibold text-fg text-ui-lg">{name}</h2>
      <div className="flex items-center gap-1">
        <span className="text-fg-muted text-ui-sm tabular-nums">{version}</span>
        <IconButton
          icon={copied ? CheckIcon : CopyIcon}
          label={copied ? d.settings.copied : d.settings.copyVersion}
          disabled={!info}
          onClick={() => {
            void navigator.clipboard.writeText(version).then(() => setCopied(true))
          }}
        />
      </div>
      <p className="text-fg-muted text-ui-sm">
        {fmt(d.settings.copyright, { year: new Date().getFullYear(), name })}
      </p>
      <p className="text-fg-muted text-ui-xs">{PLATFORM_NAMES[platform]}</p>
      <UpdateCheck />
      <Button
        variant="ghost"
        size="sm"
        className="text-fg-muted"
        onClick={() => void window.ostia.diagnostics.openLogFolder()}
      >
        <FolderOpenIcon data-icon="inline-start" aria-hidden />
        {d.crash.openLogs}
      </Button>
    </section>
  )
}
