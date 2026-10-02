import { cn } from '@/lib/utils'
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
  FileCodeIcon,
  GlobeIcon,
  type Icon as IconComponent,
  InfoIcon,
  KeyIcon,
  KeyboardIcon,
  LayoutIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  PlusIcon,
  PuzzlePieceIcon,
  RobotIcon,
  ShieldCheckIcon,
  SidebarSimpleIcon,
  SquareSplitHorizontalIcon,
  SquaresFourIcon,
  TerminalIcon,
  TerminalWindowIcon,
  TranslateIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react'
import type { ApprovalMode } from '@shared/approvals'
import { type ExtensionInfo, PRODUCT_PLACEHOLDER } from '@shared/extensions'
import {
  BELL_MODES,
  type BellMode,
  LONG_COMMAND_MAX_SECONDS,
  LONG_COMMAND_MIN_SECONDS,
  clampLongCommandSeconds,
} from '@shared/notificationSettings'
import { PRODUCT_NAME } from '@shared/product'
import type { AppInfo, Platform } from '@shared/types'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@shared/zoom'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import appIcon from '../../../resources/icon.svg'
import type { Dict, Locale } from '../i18n/dict'
import { fmt, useDict, withProductName } from '../i18n/useDict'
import { ACCENT_PRESETS, normalizeHex } from '../lib/color'
import { extensionMatchesQuery } from '../lib/extensionSettingText'
import { useReducedMotion } from '../lib/motion'
import { openFileInWorkspace } from '../lib/openFile'
import {
  EXTENSIONS_NAV_EXPANDED_KEY,
  SANDBOX_NAV_EXPANDED_KEY,
  extensionAnchorId,
  navExpanded,
  rememberNavExpanded,
} from '../lib/settingsNav'
import { firstMatchControl, matchesQuery } from '../lib/settingsSearch'
import { useEffectiveTheme } from '../lib/theme'
import { isLinux, isMac, platform } from '../platform'
import type { ClipboardKeys } from '../settings/terminalPaneSettings'
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
} from '../settings/terminalPaneSettings'
import { WINDOW_TITLE_MAX } from '../settings/windowTitle'
import { useExtensionsStore } from '../stores/extensionsStore'
import { usePluginsStore } from '../stores/pluginsStore'
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
} from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ActionsSection } from './ActionsSection'
import { AssistantSection, isAssistExtension } from './AssistantSection'
import { BrowserSettingsSection, EditorSettingsSection } from './BrowserEditorSettings'
import { ExtensionAgentPlugin } from './ExtensionAgentPlugin'
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { FileTreeSettingsGroups } from './FilesSettingsSection'
import { FontPicker } from './FontPicker'
import { GatewaySection } from './GatewaySection'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { KeyboardSection } from './KeyboardSection'
import { LanguagesSection } from './LanguagesSection'
import { ManagerSection } from './ManagerSection'
import { MarketplaceSection, UninstallExtensionButton } from './MarketplaceSection'
import { PasswordsSection } from './PasswordsSection'
import { PromptSection } from './PromptSection'
import { SandboxSection } from './SandboxSection'
import {
  Highlight,
  SearchGroup,
  SearchScopeProvider,
  SettingsSearchSection,
  useSearchGroup,
  useSearchLeaf,
  useSearchRow,
  useSettingsSearch,
} from './SettingsSearch'
import { SyncSection } from './SyncSection'
import { ThemeRows } from './ThemeSettings'
import { UpdateCheck } from './UpdateCheck'
import { ViewsSection } from './ViewsSection'
import { WorkspaceSandboxPage } from './WorkspaceSandboxPage'
import { WorkspacesSection } from './WorkspacesSection'
import { ATTENTION_ALERT } from './attentionStyles'
import { extensionIcon } from './extensionIcons'
import { Alert } from './ui/alert'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { ScrollArea } from './ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

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
  | 'browser'
  | 'passwords'
  | 'editor'
  | 'extensions'
  | 'views'
  | 'languageServers'
  | 'remote'
  | 'sync'
  | 'language'
  | 'about'
  | 'sandbox'
  | 'workspace'
  | 'extensionPage'

interface ExtensionAnchor {
  id: string
  nonce: number
}

const ANCHOR_HIGHLIGHT_MS = 2000
const EXTENSIONS_NAV_LIST_ID = 'settings-nav-extensions'
const SANDBOX_NAV_LIST_ID = 'settings-nav-sandbox'
const SANDBOX_DEFAULTS_ITEM = ''

interface NavChild {
  id: string
  label: string
  icon: IconComponent | null
  current: boolean
}

export function SettingsPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.settingsActive)
  const close = useUIStore((s) => s.showWorkspaces)
  const [active, setActive] = useState<SectionId>('appearance')
  const requested = useUIStore((s) => s.settingsSection)
  const requestedExtension = useUIStore((s) => s.settingsExtension)
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

  const sections = useMemo(
    () =>
      [
        { id: 'appearance', icon: PaletteIcon, label: d.settings.appearance },
        { id: 'terminal', icon: TerminalWindowIcon, label: d.settings.terminal },
        { id: 'prompt', icon: TerminalIcon, label: d.prompt.title },
        { id: 'keyboard', icon: KeyboardIcon, label: d.keyboard.title },
        { id: 'panes', icon: SquareSplitHorizontalIcon, label: d.settings.panes },
        { id: 'notifications', icon: BellIcon, label: d.settings.notifications },
        { id: 'sidebar', icon: SidebarSimpleIcon, label: d.settings.sidebar },
        { id: 'workspaces', icon: SquaresFourIcon, label: d.workspaceSettings.title },
        { id: 'sandbox', icon: ShieldCheckIcon, label: d.sandbox.title },
        { id: 'agents', icon: RobotIcon, label: d.settings.agents },
        { id: 'assistant', icon: ChatCircleDotsIcon, label: d.assistantSettings.title },
        ...(platform === 'linux'
          ? [{ id: 'manager' as const, icon: BroadcastIcon, label: d.manager.settingsTitle }]
          : []),
        { id: 'files', icon: TreeStructureIcon, label: d.settings.files },
        { id: 'browser', icon: GlobeIcon, label: d.browserSettings.title },
        { id: 'passwords', icon: KeyIcon, label: d.passwords.title },
        { id: 'editor', icon: FileCodeIcon, label: d.editorSettings.title },
        { id: 'extensions', icon: PuzzlePieceIcon, label: d.settings.extensions },
        { id: 'views', icon: LayoutIcon, label: d.views.title },
        { id: 'languageServers', icon: BracketsCurlyIcon, label: d.languageServers.title },
        { id: 'remote', icon: DeviceMobileIcon, label: d.settings.remote },
        { id: 'sync', icon: ArrowsClockwiseIcon, label: d.sync.title },
        { id: 'language', icon: TranslateIcon, label: d.settings.language },
        { id: 'about', icon: InfoIcon, label: d.settings.about },
      ] satisfies { id: SectionId; icon: IconComponent; label: string }[],
    [d],
  )

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
    setQuery('')
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

  const openSettingsFile = async (): Promise<void> => {
    const path = await window.pine.settings.path()
    close()
    openFileInWorkspace(path)
  }

  if (!open) return null

  const q = query.trim().toLowerCase()
  const matchingExtensions = q ? extensions.filter((e) => extensionMatchesQuery(e, q)) : extensions
  const hitsIn = (id: string): number => (q ? (searchHits[id] ?? 0) : 0)
  const settingsPageExtensions = extensions.filter((e) => e.settingsPage)
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
      {id === 'browser' ? <BrowserSettingsSection /> : null}
      {id === 'passwords' ? <PasswordsSection /> : null}
      {id === 'editor' ? <EditorSettingsSection /> : null}
      {id === 'extensions' || (id === 'extensionPage' && !shownPage) ? (
        <ExtensionsPage anchor={anchor} />
      ) : null}
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
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation()
                  setQuery('')
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
            <ul className="flex flex-col gap-0.5 px-2 pb-2">
              {visible.map((s) =>
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
          </ScrollArea>
          <Button variant="outline" size="sm" onClick={openSettingsFile} className="m-2">
            <FileCodeIcon data-icon="inline-start" />
            {d.settings.openFile}
          </Button>
        </nav>

        <ScrollArea className="min-h-0">
          <div ref={contentRef} className="mx-auto max-w-3xl px-8 py-5">
            {q ? (
              <>
                {visible.length === 0 ? (
                  <p className="text-fg-muted text-ui-sm">{d.settings.noMatches}</p>
                ) : null}
                {sections.map((s) => (
                  <Fragment key={s.id}>
                    <SettingsSearchSection
                      id={s.id}
                      label={s.label}
                      query={q}
                      onHits={onSearchHits}
                    >
                      {page(s.id)}
                    </SettingsSearchSection>
                    {s.id === 'extensions'
                      ? settingsPageExtensions.map((ext) => (
                          <SettingsSearchSection
                            key={ext.id}
                            id={extensionPageResultId(ext.id)}
                            label={pageTitle(ext)}
                            query={q}
                            onHits={onSearchHits}
                          >
                            <ExtensionSettingsPage ext={ext} />
                          </SettingsSearchSection>
                        ))
                      : null}
                  </Fragment>
                ))}
              </>
            ) : (
              page(active)
            )}
          </div>
        </ScrollArea>
      </div>
    </section>
  )
}

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

export function WarningNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <Alert className={cn(ATTENTION_ALERT, 'mt-1')}>{children}</Alert>
}

export function ControlRow({
  label,
  desc,
  error,
  errorId,
  labelHint,
  children,
}: {
  label: string
  desc?: string
  error?: string | null
  errorId?: string
  labelHint?: React.ReactNode
  children: React.ReactNode
}): JSX.Element {
  const search = useSearchRow([label, desc])
  return (
    <div
      data-settings-row
      hidden={search.hidden}
      data-search-hit={search.hit || undefined}
      className={`flex justify-between gap-6 py-1.5 ${desc || error ? 'items-start' : 'items-center'}`}
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
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <SearchScopeProvider value={search.scope}>{children}</SearchScopeProvider>
      </div>
    </div>
  )
}

export function SelectField<T extends string>({
  value,
  onChange,
  options,
  label,
  width = 'w-fit min-w-44 max-w-80',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
  label: string
  width?: string
}): JSX.Element {
  const current = options.find((o) => o.value === value)?.label ?? value
  useSearchLeaf(options.map((o) => o.label))
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" aria-label={label} className={width}>
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

export function ToggleRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string
  desc: string
  checked: boolean
  onChange: (v: boolean) => void
}): JSX.Element {
  return (
    <ControlRow label={label} desc={desc}>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} />
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

function AgentsSection(): JSX.Element {
  const d = useDict()
  const hibernation = useSettingsStore((s) => s.agents.hibernation)
  const set = useSettingsStore((s) => s.setHibernation)
  const autoResume = useSettingsStore((s) => s.agents.autoResume)
  const setAutoResume = useSettingsStore((s) => s.setAutoResume)
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
      <SettingsGroup title={d.settings.groupResume}>
        <ToggleRow
          label={d.settings.autoResume}
          desc={d.settings.autoResumeDesc}
          checked={autoResume}
          onChange={setAutoResume}
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
  const primarySelection = useSettingsStore((s) => s.terminal.primarySelection)
  const macOptionIsMeta = useSettingsStore((s) => s.terminal.macOptionIsMeta)
  const modeLabel: Record<InputMode, string> = {
    terminal: d.settings.inputModeTerminal,
    editor: d.settings.inputModeEditor,
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
          desc={promptStyle === 'pine' ? d.settings.promptStylePine : d.settings.promptStyleShell}
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => useUIStore.getState().openSettings('prompt')}
          >
            {d.settings.promptOpen}
            <CaretRightIcon data-icon="inline-end" />
          </Button>
        </ControlRow>
        {promptStyle === 'pine' && mode !== 'editor' ? (
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
  const search = useSettingsSearch()
  return (
    <section>
      <SectionHead title={d.settings.extensions} />
      {search && !search.forced ? null : (
        <>
          <MarketplaceSection />
          <Separator className="my-3" />
        </>
      )}
      <ExtensionsSection anchor={anchor} />
    </section>
  )
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

function extensionStatusLabel(d: Dict, ext: ExtensionInfo): string {
  switch (ext.status) {
    case 'running':
      return d.extensions.statusRunning
    case 'starting':
      return d.extensions.statusStarting
    case 'crashed':
      return d.extensions.statusCrashed
    case 'disabled':
      return d.extensions.statusDisabled
    case 'pending-approval':
      return d.extensions.statusPending
    default:
      return d.extensions.statusIdle
  }
}

export function ExtensionsSection({
  anchor = null,
}: {
  anchor?: ExtensionAnchor | null
}): JSX.Element {
  const d = useDict()
  const list = useExtensionsStore((s) => s.list)
  const setEnabled = useExtensionsStore((s) => s.setEnabled)
  const review = useExtensionsStore((s) => s.review)
  const reducedMotion = useReducedMotion()
  const [flash, setFlash] = useState<ExtensionAnchor | null>(null)
  const anchorListed = anchor !== null && list.some((e) => e.id === anchor.id)

  useEffect(() => {
    if (!anchor || !anchorListed) return
    const block = document.getElementById(extensionAnchorId(anchor.id))
    block?.scrollIntoView({ block: 'start' })
    block?.focus({ preventScroll: true })
    setFlash(anchor)
    const timer = setTimeout(() => setFlash(null), ANCHOR_HIGHLIGHT_MS)
    return () => clearTimeout(timer)
  }, [anchor, anchorListed])
  return (
    <section aria-label={d.extensions.title}>
      <SubHead title={d.extensions.installed} desc={d.extensions.desc} />
      {list.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.extensions.none}</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((ext) => (
            <SearchGroup key={ext.id} texts={[ext.name, withProductName(ext.description)]}>
              {(search) => (
                <li
                  id={extensionAnchorId(ext.id)}
                  tabIndex={-1}
                  aria-label={ext.name}
                  hidden={search.hidden}
                  data-search-hit={search.hit || undefined}
                  className="relative -mx-3 flex scroll-mt-3 flex-col rounded-sm px-3 py-2 outline-none"
                >
                  {flash?.id === ext.id ? (
                    <span
                      key={flash.nonce}
                      aria-hidden
                      data-testid="extension-anchor-highlight"
                      className={cn(
                        'settings-anchor-highlight pointer-events-none absolute inset-0 rounded-sm',
                        reducedMotion && 'settings-anchor-highlight-static',
                      )}
                    />
                  ) : null}
                  <div className="flex items-start justify-between gap-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-fg text-ui-base">
                          <Highlight text={ext.name} />
                        </span>
                        <span className="text-fg-muted text-ui-xs tabular-nums">{ext.version}</span>
                        <Badge variant="outline" className="text-ui-xs">
                          {d.extensions.categories[ext.category]}
                        </Badge>
                        {ext.builtin ? (
                          <Badge variant="outline" className="text-ui-xs">
                            {d.settings.builtin}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-fg-muted text-ui-sm">
                        <Highlight text={withProductName(ext.description)} />
                      </p>
                      <p className="mt-0.5 text-fg-muted text-ui-xs">
                        {extensionStatusLabel(d, ext)} ·{' '}
                        {fmt(d.extensions.permissionsList, {
                          list:
                            ext.granted.length > 0
                              ? ext.granted.join(', ')
                              : d.extensions.noPermissions,
                        })}
                      </p>
                      {ext.unapproved.length > 0 && ext.status !== 'pending-approval' ? (
                        <p className="mt-0.5 text-attn-fg text-ui-xs">
                          {fmt(d.extensions.unapproved, { caps: ext.unapproved.join(', ') })}
                        </p>
                      ) : null}
                      <ExtensionAgentPlugin ext={ext} explain={false} />
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {!ext.builtin &&
                      (ext.status === 'pending-approval' || ext.unapproved.length > 0) ? (
                        <Button variant="outline" size="sm" onClick={() => review(ext.id)}>
                          {d.extensions.review}
                        </Button>
                      ) : null}
                      <UninstallExtensionButton extId={ext.id} name={ext.name} />
                      <Switch
                        checked={ext.enabled}
                        onCheckedChange={(v) => void setEnabled(ext.id, v)}
                        aria-label={fmt(d.extensions.enable, { name: ext.name })}
                      />
                    </div>
                  </div>
                  {ext.settingsPage ? (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-5 self-start px-0 text-ui-sm"
                      onClick={() =>
                        useUIStore.getState().openSettings('extensions', { extension: ext.id })
                      }
                    >
                      {d.extensions.openSettingsPage}
                    </Button>
                  ) : !isAssistExtension(ext) ? (
                    <ExtensionSettingsForm ext={ext} />
                  ) : ext.enabled ? (
                    <Button
                      variant="link"
                      size="xs"
                      className="h-5 self-start px-0 text-ui-sm"
                      onClick={() => useUIStore.getState().openSettings('assistant')}
                    >
                      {d.assistantSettings.configure}
                    </Button>
                  ) : null}
                </li>
              )}
            </SearchGroup>
          ))}
        </ul>
      )}
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
    window.pine
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const name = info?.name ?? PRODUCT_NAME
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
    </section>
  )
}
