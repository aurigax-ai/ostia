import { cn } from '@/lib/utils'
import {
  ArrowsClockwiseIcon,
  BellIcon,
  CheckIcon,
  CodeIcon,
  CopyIcon,
  DeviceMobileIcon,
  GlobeIcon,
  HardDrivesIcon,
  type Icon as IconComponent,
  InfoIcon,
  MagnifyingGlassIcon,
  PaletteIcon,
  SidebarSimpleIcon,
  SquaresFourIcon,
  StackIcon,
  TerminalWindowIcon,
  TranslateIcon,
  TreeStructureIcon,
} from '@phosphor-icons/react'
import type { ExtensionInfo } from '@shared/extensions'
import { PRODUCT_NAME } from '@shared/product'
import type { AppInfo } from '@shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import appIcon from '../../../resources/icon.svg'
import type { Dict, Locale } from '../i18n/dict'
import { fmt, useDict } from '../i18n/useDict'
import { openFileInWorkspace } from '../lib/openFile'
import { platform } from '../platform'
import { useExtensionsStore } from '../stores/extensionsStore'
import { type LspStatus, usePluginsStore } from '../stores/pluginsStore'
import {
  CURSOR_STYLES,
  type CursorStyle,
  FONT_WEIGHTS,
  type FontSurface,
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
import { BrowserSettingsSection, EditorSettingsSection } from './BrowserEditorSettings'
import { FontPicker } from './FontPicker'
import { GatewaySection } from './GatewaySection'
import { Hint } from './Hint'
import { IconButton } from './IconButton'
import { SyncSection } from './SyncSection'
import { WorkspacesSection } from './WorkspacesSection'
import { ATTENTION_ALERT } from './attentionStyles'
import { Alert } from './ui/alert'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from './ui/input-group'
import { ScrollArea } from './ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

type SectionId =
  | 'appearance'
  | 'terminal'
  | 'notifications'
  | 'sidebar'
  | 'workspaces'
  | 'files'
  | 'browser'
  | 'editor'
  | 'plugins'
  | 'languageServers'
  | 'remote'
  | 'sync'
  | 'language'
  | 'about'

export function SettingsPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.settingsActive)
  const close = useUIStore((s) => s.leaveSettings)
  const [active, setActive] = useState<SectionId>('appearance')
  const [query, setQuery] = useState('')
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
        { id: 'notifications', icon: BellIcon, label: d.settings.notifications },
        { id: 'sidebar', icon: SidebarSimpleIcon, label: d.settings.sidebar },
        { id: 'workspaces', icon: SquaresFourIcon, label: d.workspaceSettings.title },
        { id: 'files', icon: TreeStructureIcon, label: d.settings.files },
        { id: 'browser', icon: GlobeIcon, label: d.browserSettings.title },
        { id: 'editor', icon: CodeIcon, label: d.editorSettings.title },
        { id: 'plugins', icon: StackIcon, label: d.settings.plugins },
        { id: 'languageServers', icon: HardDrivesIcon, label: d.settings.languageServers },
        { id: 'remote', icon: DeviceMobileIcon, label: d.settings.remote },
        { id: 'sync', icon: ArrowsClockwiseIcon, label: d.sync.title },
        { id: 'language', icon: TranslateIcon, label: d.settings.language },
        { id: 'about', icon: InfoIcon, label: d.settings.about },
      ] satisfies { id: SectionId; icon: IconComponent; label: string }[],
    [d],
  )

  const openSettingsFile = async (): Promise<void> => {
    const path = await window.pine.settings.path()
    close()
    openFileInWorkspace(path)
  }

  if (!open) return null

  const q = query.trim().toLowerCase()
  const visible = q ? sections.filter((s) => s.label.toLowerCase().includes(q)) : sections

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
              {visible.map((s) => (
                <li key={s.id}>
                  <Button
                    variant="ghost"
                    onClick={() => setActive(s.id)}
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
              ))}
            </ul>
          </ScrollArea>
          <Button variant="outline" size="sm" onClick={openSettingsFile} className="m-2">
            <TerminalWindowIcon data-icon="inline-start" />
            {d.settings.openFile}
          </Button>
        </nav>

        <ScrollArea className="min-h-0">
          <div className="mx-auto max-w-3xl px-8 py-5">
            {active === 'appearance' ? <AppearanceSection /> : null}
            {active === 'terminal' ? <TerminalSection /> : null}
            {active === 'notifications' ? <NotificationsSection /> : null}
            {active === 'sidebar' ? <SidebarSection /> : null}
            {active === 'workspaces' ? <WorkspacesSection /> : null}
            {active === 'files' ? <FilesSection /> : null}
            {active === 'browser' ? <BrowserSettingsSection /> : null}
            {active === 'editor' ? <EditorSettingsSection /> : null}
            {active === 'plugins' ? <PluginsSection /> : null}
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
  children,
}: {
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="mt-5 border-line border-t pt-5 first-of-type:mt-3 first-of-type:border-t-0 first-of-type:pt-0">
      <h3 className="mb-2 font-semibold text-fg text-ui-emphasis">{title}</h3>
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
  children,
}: {
  label: string
  desc?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className={`flex justify-between gap-6 py-1.5 ${desc ? 'items-start' : 'items-center'}`}>
      <div className="min-w-0">
        <div className="text-fg text-ui-base">{label}</div>
        {desc ? <p className="mt-0.5 text-fg-muted text-ui-sm">{desc}</p> : null}
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
  width = 'w-44',
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
        {current}
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
  const theme = useSettingsStore((s) => s.appearance.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const motion = useSettingsStore((s) => s.appearance.motion)
  const setMotion = useSettingsStore((s) => s.setMotion)
  const themes = usePluginsStore((s) => s.themes)
  const motionLabel: Record<MotionMode, string> = {
    system: d.settings.motionSystem,
    reduced: d.settings.motionReduced,
    full: d.settings.motionFull,
  }
  return (
    <div>
      <SectionHead title={d.settings.appearance} />
      <SettingsGroup title={d.settings.groupTheme}>
        <ControlRow label={d.settings.theme}>
          <SelectField
            value={theme}
            onChange={setTheme}
            label={d.settings.theme}
            options={themes.map((t) => ({ value: t.id, label: t.name }))}
          />
        </ControlRow>
        <ControlRow label={d.settings.motion} desc={d.settings.motionDesc}>
          <SelectField
            value={motionMode(motion)}
            onChange={setMotion}
            label={d.settings.motion}
            options={MOTION_MODES.map((m) => ({ value: m, label: motionLabel[m] }))}
          />
        </ControlRow>
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
          label={d.settings.notifyWhenFocused}
          desc={d.settings.notifyWhenFocusedDesc}
          checked={n.whenFocused}
          onChange={(v) => set({ whenFocused: v })}
        />
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
  const setBehavior = useSettingsStore((s) => s.setBehavior)
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

function FilesSection(): JSX.Element {
  const d = useDict()
  const showHidden = useSettingsStore((s) => s.behavior.showHiddenFiles)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  return (
    <section>
      <SectionHead title={d.settings.files} />
      <ToggleRow
        label={d.settings.showHiddenFiles}
        desc={d.settings.showHiddenFilesDesc}
        checked={showHidden}
        onChange={(v) => setBehavior({ showHiddenFiles: v })}
      />
      <ExternalEditorRow />
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

function PluginsSection(): JSX.Element {
  const d = useDict()
  const plugins = usePluginsStore((s) => s.plugins)
  return (
    <section>
      <SectionHead title={d.settings.plugins} />
      <div className="flex flex-col">
        {plugins.map((p) => (
          <Hint key={p.id} label={p.id} side="left">
            <div className="rounded-sm px-3 py-2 hover:bg-surface-2/60">
              <div className="flex items-center gap-2">
                <span className="text-fg text-ui-base">{p.name}</span>
                {p.builtin ? (
                  <span className="rounded-sm border border-line px-1.5 text-fg-muted text-ui-xs">
                    {d.settings.builtin}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 text-fg-muted text-ui-sm">{p.description}</p>
            </div>
          </Hint>
        ))}
      </div>
      <Separator className="my-3" />
      <ExtensionsSection />
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

export function ExtensionsSection(): JSX.Element {
  const d = useDict()
  const list = useExtensionsStore((s) => s.list)
  const setEnabled = useExtensionsStore((s) => s.setEnabled)
  const review = useExtensionsStore((s) => s.review)
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
              className="flex items-start justify-between gap-6 rounded-sm px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-fg text-ui-base">{ext.name}</span>
                  <span className="text-fg-muted text-ui-xs tabular-nums">{ext.version}</span>
                  {ext.builtin ? (
                    <span className="rounded-sm border border-line px-1.5 text-fg-muted text-ui-xs">
                      {d.settings.builtin}
                    </span>
                  ) : null}
                </div>
                <p className="mt-0.5 text-fg-muted text-ui-sm">{ext.description}</p>
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

function LanguageSection(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const setLocale = useSettingsStore((s) => s.setLocale)
  const languages = usePluginsStore((s) => s.languages)
  return (
    <section>
      <SectionHead title={d.settings.language} />
      <ControlRow label={d.settings.language}>
        <SelectField
          value={locale}
          onChange={(l) => setLocale(l as Locale)}
          label={d.settings.language}
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
        <span className="font-mono text-fg-muted text-ui-sm tabular-nums">{version}</span>
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
      <p className="text-fg-muted text-ui-xs">{platform}</p>
    </section>
  )
}
