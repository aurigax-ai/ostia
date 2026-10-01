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
  FolderSimpleIcon,
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
import type { ExtensionInfo } from '@shared/extensions'
import { PRODUCT_NAME } from '@shared/product'
import type { AppInfo, Platform } from '@shared/types'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@shared/zoom'
import { useEffect, useMemo, useRef, useState } from 'react'
import appIcon from '../../../resources/icon.svg'
import type { Dict, Locale } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { ACCENT_PRESETS, normalizeHex } from '../lib/color'
import { extensionMatchesQuery, withProductName } from '../lib/extensionSettingText'
import { useReducedMotion } from '../lib/motion'
import { openFileInWorkspace } from '../lib/openFile'
import {
  extensionAnchorId,
  pluginsNavExpanded,
  rememberPluginsNavExpanded,
} from '../lib/settingsNav'
import { useEffectiveTheme } from '../lib/theme'
import { isMac, platform } from '../platform'
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
import { type LspStatus, usePluginsStore } from '../stores/pluginsStore'
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
import { ExtensionSettingsForm } from './ExtensionSettingsForm'
import { FileTreeSettingsGroups } from './FilesSettingsSection'
import { FontPicker } from './FontPicker'
import { GatewaySection } from './GatewaySection'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { KeyboardSection } from './KeyboardSection'
import { ManagerSection } from './ManagerSection'
import { PasswordsSection } from './PasswordsSection'
import { PromptSection } from './PromptSection'
import { SandboxSection } from './SandboxSection'
import { SyncSection } from './SyncSection'
import { ThemeRows } from './ThemeSettings'
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
  | 'plugins'
  | 'views'
  | 'languageServers'
  | 'remote'
  | 'sync'
  | 'language'
  | 'about'
  | 'sandbox'
  | 'workspace'

interface ExtensionAnchor {
  id: string
  nonce: number
}

const ANCHOR_HIGHLIGHT_MS = 2000
const PLUGINS_NAV_LIST_ID = 'settings-nav-plugins'

export function SettingsPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.settingsActive)
  const close = useUIStore((s) => s.leaveSettings)
  const [active, setActive] = useState<SectionId>('appearance')
  const requested = useUIStore((s) => s.settingsSection)
  const requestedExtension = useUIStore((s) => s.settingsExtension)
  const extensions = useExtensionsStore((s) => s.list)
  const [pluginsExpanded, setPluginsExpanded] = useState(pluginsNavExpanded)
  const [anchor, setAnchor] = useState<ExtensionAnchor | null>(null)
  const pluginsButtonRef = useRef<HTMLButtonElement>(null)
  const [query, setQuery] = useState('')
  const settingsWorkspaceId = useUIStore((s) => s.settingsWorkspaceId)
  const settingsRequest = useUIStore((s) => s.settingsRequest)
  const targetWorkspace = useWorkspacesStore((s) =>
    s.workspaces.find((w) => w.id === settingsWorkspaceId),
  )

  useEffect(() => {
    if (settingsRequest > 0) setActive('workspace')
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
        { id: 'plugins', icon: PuzzlePieceIcon, label: d.settings.plugins },
        { id: 'views', icon: LayoutIcon, label: d.views.title },
        { id: 'languageServers', icon: BracketsCurlyIcon, label: d.settings.languageServers },
        { id: 'remote', icon: DeviceMobileIcon, label: d.settings.remote },
        { id: 'sync', icon: ArrowsClockwiseIcon, label: d.sync.title },
        { id: 'language', icon: TranslateIcon, label: d.settings.language },
        { id: 'about', icon: InfoIcon, label: d.settings.about },
      ] satisfies { id: SectionId; icon: IconComponent; label: string }[],
    [d],
  )

  const expandPlugins = (expanded: boolean): void => {
    setPluginsExpanded(expanded)
    rememberPluginsNavExpanded(expanded)
  }

  const openSection = (id: SectionId): void => {
    setActive(id)
    setAnchor(null)
  }

  const openExtension = (id: string): void => {
    setActive('plugins')
    setAnchor((prev) => ({ id, nonce: (prev?.nonce ?? 0) + 1 }))
  }

  useEffect(() => {
    if (!requested) return
    if (sections.some((s) => s.id === requested)) {
      setActive(requested as SectionId)
      if (requested === 'plugins' && requestedExtension) {
        setAnchor((prev) => ({ id: requestedExtension, nonce: (prev?.nonce ?? 0) + 1 }))
        setPluginsExpanded(true)
        rememberPluginsNavExpanded(true)
      } else {
        setAnchor(null)
      }
    }
    useUIStore.setState({ settingsSection: null, settingsExtension: null })
  }, [requested, requestedExtension, sections])

  const openSettingsFile = async (): Promise<void> => {
    const path = await window.pine.settings.path()
    close()
    openFileInWorkspace(path)
  }

  if (!open) return null

  const q = query.trim().toLowerCase()
  const workspaceLabel = targetWorkspace
    ? fmt(d.sandbox.workspacePage, { name: targetWorkspace.customName ?? targetWorkspace.name })
    : null
  const all = workspaceLabel
    ? [...sections, { id: 'workspace' as const, icon: FolderSimpleIcon, label: workspaceLabel }]
    : sections
  const matchingExtensions = q ? extensions.filter((e) => extensionMatchesQuery(e, q)) : extensions
  const visible = q
    ? all.filter(
        (s) =>
          s.label.toLowerCase().includes(q) ||
          (s.id === 'plugins' && matchingExtensions.length > 0),
      )
    : all
  const navExtensions = q ? matchingExtensions : extensions
  const pluginsChildrenShown = navExtensions.length > 0 && (q !== '' || pluginsExpanded)

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
              placeholder={d.settings.search}
              aria-label={d.settings.search}
            />
          </InputGroup>
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-0.5 px-2 pb-2">
              {visible.map((s) =>
                s.id === 'plugins' ? (
                  <PluginsNavItem
                    key={s.id}
                    label={s.label}
                    icon={s.icon}
                    current={active === 'plugins' && !anchor}
                    extensions={navExtensions}
                    anchoredId={active === 'plugins' ? (anchor?.id ?? null) : null}
                    expanded={pluginsChildrenShown}
                    canToggle={q === '' && extensions.length > 0}
                    buttonRef={pluginsButtonRef}
                    onOpen={() => openSection('plugins')}
                    onToggle={expandPlugins}
                    onOpenExtension={openExtension}
                  />
                ) : (
                  <li key={s.id}>
                    <Button
                      variant="ghost"
                      onClick={() => openSection(s.id)}
                      aria-current={active === s.id ? 'page' : undefined}
                      className={cn(
                        'w-full justify-start gap-2.5 font-normal text-ui-base',
                        active === s.id ? 'bg-surface-2 text-fg' : 'text-fg-muted',
                      )}
                    >
                      <s.icon className={active === s.id ? 'text-fg' : 'text-fg-muted'} />
                      {s.label}
                    </Button>
                  </li>
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
          <div className="mx-auto max-w-3xl px-8 py-5">
            {active === 'appearance' ? <AppearanceSection /> : null}
            {active === 'terminal' ? <TerminalSection /> : null}
            {active === 'prompt' ? <PromptSection /> : null}
            {active === 'keyboard' ? (
              <>
                <KeyboardSection />
                <ActionsSection />
              </>
            ) : null}
            {active === 'panes' ? <PanesSection /> : null}
            {active === 'notifications' ? <NotificationsSection /> : null}
            {active === 'sidebar' ? <SidebarSection /> : null}
            {active === 'workspaces' ? <WorkspacesSection /> : null}
            {active === 'sandbox' ? <SandboxSection /> : null}
            {active === 'workspace' && targetWorkspace ? (
              <WorkspaceSandboxPage
                key={targetWorkspace.id}
                workspaceId={targetWorkspace.id}
                workspaceName={targetWorkspace.customName ?? targetWorkspace.name}
              />
            ) : null}
            {active === 'agents' ? <AgentsSection /> : null}
            {active === 'assistant' ? <AssistantSection /> : null}
            {active === 'manager' ? <ManagerSection /> : null}
            {active === 'files' ? <FilesSection /> : null}
            {active === 'browser' ? <BrowserSettingsSection /> : null}
            {active === 'passwords' ? <PasswordsSection /> : null}
            {active === 'editor' ? <EditorSettingsSection /> : null}
            {active === 'plugins' ? <PluginsSection anchor={anchor} /> : null}
            {active === 'views' ? <ViewsSection /> : null}
            {active === 'languageServers' ? <LanguageServersSection /> : null}
            {active === 'remote' ? <GatewaySection /> : null}
            {active === 'sync' ? <SyncSection /> : null}
            {active === 'language' ? <LanguageSection /> : null}
            {active === 'about' ? <AboutSection /> : null}
          </div>
        </ScrollArea>
      </div>
    </section>
  )
}

function PluginsNavItem({
  label,
  icon: SectionIcon,
  current,
  extensions,
  anchoredId,
  expanded,
  canToggle,
  buttonRef,
  onOpen,
  onToggle,
  onOpenExtension,
}: {
  label: string
  icon: IconComponent
  current: boolean
  extensions: ExtensionInfo[]
  anchoredId: string | null
  expanded: boolean
  canToggle: boolean
  buttonRef: React.RefObject<HTMLButtonElement>
  onOpen: () => void
  onToggle: (expanded: boolean) => void
  onOpenExtension: (id: string) => void
}): JSX.Element {
  const d = useDict()
  const emphasized = current || anchoredId !== null
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
        </Button>
        {canToggle ? (
          <IconButton
            icon={CaretRightIcon}
            label={d.settings.pluginsNavList}
            aria-expanded={expanded}
            aria-controls={expanded ? PLUGINS_NAV_LIST_ID : undefined}
            onClick={() => onToggle(!expanded)}
            className={cn('mr-1 [&_svg]:transition-transform', expanded && '[&_svg]:rotate-90')}
          />
        ) : null}
      </div>
      {expanded ? (
        <ul
          id={PLUGINS_NAV_LIST_ID}
          aria-label={d.settings.pluginsNavList}
          className="mt-0.5 ml-4 flex flex-col gap-0.5 border-line border-l pl-1.5"
        >
          {extensions.map((ext) => {
            const ExtIcon = ext.panel?.icon ? extensionIcon(ext.panel.icon) : null
            const isCurrent = anchoredId === ext.id
            return (
              <li key={ext.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenExtension(ext.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      e.preventDefault()
                      buttonRef.current?.focus()
                    }
                  }}
                  aria-current={isCurrent ? 'location' : undefined}
                  className={cn(
                    'w-full justify-start gap-2 font-normal text-ui-sm',
                    isCurrent ? 'bg-surface-2 text-fg' : 'text-fg-muted',
                  )}
                >
                  {ExtIcon ? (
                    <ExtIcon className={isCurrent ? 'text-fg' : 'text-fg-muted'} />
                  ) : (
                    <span aria-hidden className="size-4 shrink-0" />
                  )}
                  <span className="min-w-0 truncate">{ext.name}</span>
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
  return (
    <>
      <h2 className="mb-1.5 font-semibold text-fg text-ui-lg">{title}</h2>
      {desc ? <p className="mb-3 text-fg-muted text-ui-sm">{desc}</p> : null}
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
  return (
    <section className="mt-5 border-line border-t pt-5 first-of-type:mt-3 first-of-type:border-t-0 first-of-type:pt-0">
      <div className="mb-2 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="font-semibold text-fg text-ui-emphasis">{title}</h3>
          {desc ? <p className="mt-0.5 text-fg-muted text-ui-sm">{desc}</p> : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

export function SubHead({ title, desc }: { title: string; desc?: string }): JSX.Element {
  return (
    <div className="mb-2">
      <h3 className="font-medium text-fg text-ui-base">{title}</h3>
      {desc ? <p className="mt-0.5 text-fg-muted text-ui-sm">{desc}</p> : null}
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
  return (
    <div
      className={`flex justify-between gap-6 py-1.5 ${desc || error ? 'items-start' : 'items-center'}`}
    >
      <div className="min-w-0">
        {labelHint ? (
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="text-fg text-ui-base">{label}</span>
            {labelHint}
          </div>
        ) : (
          <div className="text-fg text-ui-base">{label}</div>
        )}
        {desc ? <p className="mt-0.5 text-fg-muted text-ui-sm">{desc}</p> : null}
        {error ? (
          <p id={errorId} role="alert" className="mt-0.5 text-attn-fg text-ui-sm">
            {error}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
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
  return (
    <Select value={value} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger size="sm" aria-label={label} className={width}>
        <span className="min-w-0 truncate">{current}</span>
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
        <FontRow surface="ui" label={d.settings.uiFont} />
        <FontRow surface="terminal" label={d.settings.terminalFont} />
        <LineHeightRow />
        <FontRow surface="editor" label={d.settings.editorFont} />
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
    <ControlRow label={d.settings.windowTitle} desc={d.settings.windowTitleDesc}>
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

function FontRow({ surface, label }: { surface: FontSurface; label: string }): JSX.Element {
  const d = useDict()
  const font = useSettingsStore((s) => s.appearance[surface])
  const setSurfaceFont = useSettingsStore((s) => s.setSurfaceFont)
  return (
    <ControlRow label={label}>
      <FontPicker
        value={font.family}
        label={`${label}, ${d.settings.family}`}
        onChange={(family) => setSurfaceFont(surface, { family })}
      />
      <SelectField
        value={String(font.weight)}
        onChange={(w) => setSurfaceFont(surface, { weight: Number(w) })}
        label={`${label}, ${d.settings.weight}`}
        width="w-20"
        options={FONT_WEIGHTS.map((w) => ({ value: String(w), label: String(w) }))}
      />
      <Input
        type="number"
        min={8}
        max={32}
        value={font.size}
        aria-label={`${label}, ${d.settings.size}`}
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
          label={fmt(d.settings.notifyWhenFocused, { product: PRODUCT_NAME })}
          desc={fmt(d.settings.notifyWhenFocusedDesc, { product: PRODUCT_NAME })}
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
          label={d.settings.sidebarPorts}
          desc={d.settings.sidebarPortsDesc}
          checked={sidebar.showPorts}
          onChange={(v) => set({ showPorts: v })}
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
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const scrollSpeed = useSettingsStore((s) => s.terminal.scrollSpeed)
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines)
  const warnOnRiskyPaste = useSettingsStore((s) => s.terminal.warnOnRiskyPaste)
  const clipboardKeys = useSettingsStore((s) => s.terminal.clipboardKeys)
  const minimumContrast = useSettingsStore((s) => s.terminal.minimumContrast)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const promptStyle = useSettingsStore((s) => s.terminal.prompt.style)
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

function PluginsSection({ anchor }: { anchor: ExtensionAnchor | null }): JSX.Element {
  const d = useDict()
  const plugins = usePluginsStore((s) => s.plugins)
  return (
    <section>
      <SectionHead title={d.settings.plugins} />
      <div className="flex flex-col">
        {plugins.map((p) => (
          <div key={p.id} className="rounded-sm px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="text-fg text-ui-base">{p.name}</span>
              <span className="font-mono text-fg-muted text-ui-xs">{p.id}</span>
              {p.builtin ? (
                <Badge variant="outline" className="text-ui-xs">
                  {d.settings.builtin}
                </Badge>
              ) : null}
            </div>
            <p className="mt-0.5 text-fg-muted text-ui-sm">{p.description}</p>
          </div>
        ))}
      </div>
      <Separator className="my-3" />
      <ExtensionsSection anchor={anchor} />
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
      <SubHead title={d.extensions.title} desc={d.extensions.desc} />
      {list.length === 0 ? (
        <p className="text-fg-muted text-ui-sm">{d.extensions.none}</p>
      ) : (
        <ul className="flex flex-col">
          {list.map((ext) => (
            <li
              key={ext.id}
              id={extensionAnchorId(ext.id)}
              tabIndex={-1}
              aria-label={ext.name}
              className="relative flex scroll-mt-3 flex-col rounded-sm px-3 py-2 outline-none"
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
                    <span className="text-fg text-ui-base">{ext.name}</span>
                    <span className="text-fg-muted text-ui-xs tabular-nums">{ext.version}</span>
                    {ext.builtin ? (
                      <Badge variant="outline" className="text-ui-xs">
                        {d.settings.builtin}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-fg-muted text-ui-sm">
                    {withProductName(ext.description)}
                  </p>
                  <p className="mt-0.5 text-fg-muted text-ui-xs">
                    {extensionStatusLabel(d, ext)} · {d.extensions.permissions}:{' '}
                    {ext.granted.length > 0 ? ext.granted.join(', ') : d.extensions.noPermissions}
                  </p>
                  {ext.unapproved.length > 0 && ext.status !== 'pending-approval' ? (
                    <p className="mt-0.5 text-attn-fg text-ui-xs">
                      {fmt(d.extensions.unapproved, { caps: ext.unapproved.join(', ') })}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {!ext.builtin &&
                  (ext.status === 'pending-approval' || ext.unapproved.length > 0) ? (
                    <Button variant="outline" size="sm" onClick={() => review(ext.id)}>
                      {d.extensions.review}
                    </Button>
                  ) : null}
                  <Switch
                    checked={ext.enabled}
                    onCheckedChange={(v) => void setEnabled(ext.id, v)}
                    aria-label={fmt(d.extensions.enable, { name: ext.name })}
                  />
                </div>
              </div>
              {!isAssistExtension(ext) ? (
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
          ))}
        </ul>
      )}
    </section>
  )
}

const LSP_DOT: Record<LspStatus, string> = {
  running: 'ok',
  installed: 'brand',
  missing: 'dim',
  error: 'attn',
}

function LanguageServersSection(): JSX.Element {
  const d = useDict()
  const lsp = usePluginsStore((s) => s.lsp)
  const load = usePluginsStore((s) => s.load)
  useEffect(() => {
    void load()
  }, [load])
  const statusLabel = (s: LspStatus): string =>
    s === 'running'
      ? d.plugins.running
      : s === 'installed'
        ? d.plugins.available
        : s === 'error'
          ? d.plugins.error
          : d.plugins.notInstalled
  return (
    <section>
      <SectionHead title={d.settings.languageServers} />
      <div className="plugins">
        {lsp.map((e) => (
          <div key={e.languageId} className="plugin">
            <span className={`dot plugin-dot ${LSP_DOT[e.status]}`} />
            <span className="plugin-body">
              <span className="plugin-name">{e.command}</span>
              <span className="plugin-meta">
                {e.languageId} · {statusLabel(e.status)}
              </span>
            </span>
          </div>
        ))}
      </div>
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
    </section>
  )
}
