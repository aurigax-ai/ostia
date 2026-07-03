import type { AppInfo } from '@shared/types'
import {
  Boxes,
  FolderTree,
  Info,
  Languages,
  type LucideIcon,
  Palette,
  Search,
  Server,
  SquareTerminal,
  TerminalSquare,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Locale } from '../i18n/dict'
import { useDict } from '../i18n/useDict'
import { platform } from '../platform'
import { useLayoutStore } from '../stores/layoutStore'
import { type LspStatus, usePluginsStore } from '../stores/pluginsStore'
import { useSessionsStore } from '../stores/sessionsStore'
import {
  CURSOR_STYLES,
  type CursorStyle,
  type FontSurface,
  useSettingsStore,
} from '../stores/settingsStore'
import { useUIStore } from '../stores/uiStore'
import { Input } from './ui/input'
import { ScrollArea } from './ui/scroll-area'
import { Select, SelectContent, SelectItem, SelectTrigger } from './ui/select'
import { Separator } from './ui/separator'
import { Switch } from './ui/switch'

type SectionId =
  | 'appearance'
  | 'terminal'
  | 'files'
  | 'plugins'
  | 'languageServers'
  | 'language'
  | 'about'

/**
 * Settings as a full-window, two-pane surface (Warp/VSCode preferences pattern): a
 * searchable left nav of sections + an `Open settings file` button, a scrollable right
 * pane of grouped controls (dropdowns / switches / inputs). Sits below the OS controls.
 */
export function SettingsPanel(): JSX.Element | null {
  const d = useDict()
  const open = useUIStore((s) => s.settingsActive)
  const close = useUIStore((s) => s.leaveSettings)
  const [active, setActive] = useState<SectionId>('appearance')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  // Move focus into Settings on open, and restore it to the prior element on close.
  useEffect(() => {
    if (!open) return
    const prev = document.activeElement as HTMLElement | null
    searchRef.current?.focus()
    return () => prev?.focus?.()
  }, [open])

  const sections = useMemo(
    () =>
      [
        { id: 'appearance', icon: Palette, label: d.settings.appearance },
        { id: 'terminal', icon: TerminalSquare, label: d.settings.terminal },
        { id: 'files', icon: FolderTree, label: d.settings.files },
        { id: 'plugins', icon: Boxes, label: d.settings.plugins },
        { id: 'languageServers', icon: Server, label: d.settings.languageServers },
        { id: 'language', icon: Languages, label: d.settings.language },
        { id: 'about', icon: Info, label: d.settings.about },
      ] satisfies { id: SectionId; icon: LucideIcon; label: string }[],
    [d],
  )

  const openSettingsFile = async (): Promise<void> => {
    const path = await window.pine.settings.path()
    const sessionId = useSessionsStore.getState().activeSessionId
    close()
    useLayoutStore.getState().openFile(sessionId, path)
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
        <nav className="flex min-h-0 flex-col border-line border-r bg-surface-1">
          <div className="relative m-1.5">
            <Search
              size={12}
              className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2 text-fg-dim"
            />
            <Input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={d.settings.search}
              aria-label={d.settings.search}
              className="h-7 bg-bg-sunken pl-6 text-[11px]"
            />
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <ul className="flex flex-col gap-0.5 px-2 pb-2">
              {visible.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => setActive(s.id)}
                    aria-current={active === s.id ? 'page' : undefined}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px] ${
                      active === s.id
                        ? 'bg-surface-2 text-fg'
                        : 'text-fg-muted hover:bg-surface-2/60 hover:text-fg'
                    }`}
                  >
                    <s.icon size={15} className={active === s.id ? 'text-brand' : 'text-fg-dim'} />
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </ScrollArea>
          <button
            type="button"
            onClick={openSettingsFile}
            className="m-2 flex items-center justify-center gap-2 rounded-md border border-line bg-bg-sunken px-3 py-2 font-mono text-fg-muted text-xs hover:border-line-strong hover:text-fg"
          >
            <SquareTerminal size={14} className="text-fg-dim" />
            {d.settings.openFile}
          </button>
        </nav>

        <ScrollArea className="min-h-0">
          <div className="mx-auto max-w-3xl px-8 py-5">
            {active === 'appearance' ? <AppearanceSection /> : null}
            {active === 'terminal' ? <TerminalSection /> : null}
            {active === 'files' ? <FilesSection /> : null}
            {active === 'plugins' ? <PluginsSection /> : null}
            {active === 'languageServers' ? <LanguageServersSection /> : null}
            {active === 'language' ? <LanguageSection /> : null}
            {active === 'about' ? <AboutSection /> : null}
          </div>
        </ScrollArea>
      </div>
    </section>
  )
}

function SectionHead({ title }: { title: string }): JSX.Element {
  return <h2 className="mb-1.5 font-semibold text-[16px] text-fg">{title}</h2>
}

/** A settings row: label (+ optional description) on the left, a control on the right. */
function ControlRow({
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
        <div className="text-fg text-sm">{label}</div>
        {desc ? <p className="mt-0.5 text-fg-muted text-xs leading-relaxed">{desc}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

/** A proper dropdown (Base UI Select) — the trigger shows the current option's label. */
function SelectField<T extends string>({
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
      <SelectTrigger aria-label={label} className={`${width} text-[13px]`}>
        {current}
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-[13px]">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** A label + sub-description on the left, a Switch pinned right. */
function ToggleRow({
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
  const themes = usePluginsStore((s) => s.themes)
  return (
    <section>
      <SectionHead title={d.settings.appearance} />
      <ControlRow label={d.settings.theme}>
        <SelectField
          value={theme}
          onChange={setTheme}
          label={d.settings.theme}
          options={themes.map((t) => ({ value: t.id, label: t.name }))}
        />
      </ControlRow>
      <Separator className="bg-line" />
      <FontRow surface="ui" label={d.settings.uiFont} />
      <FontRow surface="terminal" label={d.settings.terminalFont} />
      <FontRow surface="editor" label={d.settings.editorFont} />
    </section>
  )
}

function FontRow({ surface, label }: { surface: FontSurface; label: string }): JSX.Element {
  const d = useDict()
  const font = useSettingsStore((s) => s.appearance[surface])
  const setSurfaceFont = useSettingsStore((s) => s.setSurfaceFont)
  return (
    <ControlRow label={label}>
      <Input
        value={font.family}
        onChange={(e) => setSurfaceFont(surface, { family: e.target.value })}
        aria-label={`${label} — ${d.settings.family}`}
        className="h-7 w-44 font-mono text-xs"
      />
      <Input
        type="number"
        min={8}
        max={32}
        value={font.size}
        aria-label={`${label} — ${d.settings.size}`}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n) && n > 0) {
            setSurfaceFont(surface, { size: Math.min(32, Math.max(8, Math.round(n))) })
          }
        }}
        className="h-7 w-16 font-mono text-xs"
      />
    </ControlRow>
  )
}

function TerminalSection(): JSX.Element {
  const d = useDict()
  const cursorStyle = useSettingsStore((s) => s.behavior.cursorStyle)
  const cursorBlink = useSettingsStore((s) => s.behavior.cursorBlink)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const styleLabel: Record<CursorStyle, string> = {
    block: d.settings.styleBlock,
    underline: d.settings.styleUnderline,
    bar: d.settings.styleBar,
  }
  return (
    <section>
      <SectionHead title={d.settings.terminal} />
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
    </section>
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
    </section>
  )
}

/** Installed plugins + a summary of what each contributes. */
function PluginsSection(): JSX.Element {
  const d = useDict()
  const plugins = usePluginsStore((s) => s.plugins)
  return (
    <section>
      <SectionHead title={d.settings.plugins} />
      <div className="flex flex-col">
        {plugins.map((p) => (
          <div key={p.id} className="rounded-md px-3 py-2 hover:bg-surface-2/60" title={p.id}>
            <div className="flex items-center gap-2">
              <span className="text-fg text-sm">{p.name}</span>
              {p.builtin ? (
                <span className="rounded border border-line px-1.5 py-px font-mono text-[10px] text-fg-dim">
                  {d.settings.builtin}
                </span>
              ) : null}
            </div>
            <p className="mt-0.5 text-fg-muted text-xs leading-relaxed">{p.description}</p>
          </div>
        ))}
      </div>
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
          <div key={e.languageId} className="plugin" title={`${e.command} · ${e.languageId}`}>
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
  useEffect(() => {
    window.pine
      .info()
      .then(setInfo)
      .catch(() => setInfo(null))
  }, [])
  return (
    <section>
      <SectionHead title={d.settings.about} />
      <ControlRow label={d.settings.title}>
        <span className="font-mono text-fg text-sm">{info?.name ?? 'pine'}</span>
      </ControlRow>
      <ControlRow label={d.settings.version}>
        <span className="font-mono text-fg-muted text-sm">{info?.version ?? '…'}</span>
      </ControlRow>
      <ControlRow label={d.settings.platform}>
        <span className="font-mono text-fg-muted text-sm">{platform}</span>
      </ControlRow>
    </section>
  )
}
