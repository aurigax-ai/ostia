import { PRODUCT_NAME } from '@shared/product'
import { MATCH_PINE_THEME, isLinkedTheme } from '@shared/themeChoice'
import { fmt, useDict } from '../i18n/useDict'
import { type SchemeSurface, useScheme } from '../lib/colorScheme'
import { useEffectiveTheme } from '../lib/theme'
import { type CodeColors, codeColors, monacoThemeData } from '../monaco/monacoTheme'
import { ANSI_NAMES, type ColorScheme } from '../plugins/types'
import { usePluginsStore } from '../stores/pluginsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { ControlRow, SelectField, ToggleRow } from './SettingsPanel'
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from './ui/combobox'
import { InputGroupAddon } from './ui/input-group'
import { Switch } from './ui/switch'

const SWATCH_HUES = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

export function SchemeSwatch({ scheme }: { scheme: ColorScheme }): JSX.Element {
  const { colors } = scheme
  return (
    <span
      aria-hidden
      data-scheme-swatch={scheme.id}
      className="flex h-4 w-9 shrink-0 items-center justify-center gap-px rounded-sm border border-line-strong"
      style={{ background: colors.background }}
    >
      {SWATCH_HUES.map((hue) => (
        <span key={hue} className="h-2 w-[3px] rounded-[1px]" style={{ background: colors[hue] }} />
      ))}
    </span>
  )
}

function SchemePicker({
  value,
  label,
  onChange,
}: {
  value: string
  label: string
  onChange: (id: string) => void
}): JSX.Element {
  const d = useDict()
  const schemes = usePluginsStore((s) => s.colorSchemes)
  const byId = new Map(schemes.map((s) => [s.id, s]))
  const current = byId.get(value)
  return (
    <Combobox
      items={schemes.map((s) => s.id)}
      value={value}
      itemToStringLabel={(id: string) => byId.get(id)?.name ?? id}
      onValueChange={(id) => {
        if (typeof id === 'string' && id) onChange(id)
      }}
    >
      <ComboboxInput aria-label={label} placeholder={d.settings.schemeSearch} className="h-7 w-60">
        {current ? (
          <InputGroupAddon align="inline-start">
            <SchemeSwatch scheme={current} />
          </InputGroupAddon>
        ) : null}
      </ComboboxInput>
      <ComboboxContent align="end" className="w-72">
        <ComboboxEmpty>{d.settings.schemeEmpty}</ComboboxEmpty>
        <ComboboxList>
          {(id: string) => {
            const scheme = byId.get(id)
            if (!scheme) return null
            return (
              <ComboboxItem key={id} value={id} className="gap-2.5">
                <SchemeSwatch scheme={scheme} />
                <span className="min-w-0 flex-1 truncate">{scheme.name}</span>
                <span className="text-fg-muted text-ui-xs">
                  {scheme.appearance === 'light' ? d.settings.schemeLight : d.settings.schemeDark}
                </span>
              </ComboboxItem>
            )
          }}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  )
}

function SchemeRow({ surface }: { surface: SchemeSurface }): JSX.Element {
  const d = useDict()
  const choice = useSettingsStore((s) => s[surface].theme)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const setEditor = useSettingsStore((s) => s.setEditor)
  const scheme = useScheme(surface)
  const linked = isLinkedTheme(choice)
  const label = surface === 'terminal' ? d.settings.terminalColors : d.settings.editorColors
  const setChoice = (theme: string): void => {
    if (surface === 'terminal') setTerminal({ theme })
    else setEditor({ theme })
  }
  const vars = { product: PRODUCT_NAME }
  return (
    <ControlRow
      label={label}
      desc={fmt(linked ? d.settings.schemeLinkedDesc : d.settings.schemeOwnDesc, vars)}
    >
      {linked ? (
        <span
          data-testid={`${surface}-scheme`}
          className="flex h-7 w-60 items-center gap-2.5 rounded-md border border-line px-2 text-fg-muted text-ui-sm"
        >
          <SchemeSwatch scheme={scheme} />
          <span className="truncate">{scheme.name}</span>
        </span>
      ) : (
        <SchemePicker value={scheme.id} label={label} onChange={setChoice} />
      )}
      <Switch
        checked={linked}
        onCheckedChange={(on) => setChoice(on ? MATCH_PINE_THEME : scheme.id)}
        aria-label={`${label}: ${fmt(d.settings.matchTheme, vars)}`}
      />
    </ControlRow>
  )
}

const TERMINAL_LINES: [keyof ColorScheme['colors'], string][][] = [
  [
    ['blue', '~/pine '],
    ['magenta', 'main '],
    ['green', '> '],
    ['foreground', 'pnpm test'],
  ],
  [
    ['green', ' PASS '],
    ['foreground', 'src/theme.test.ts'],
  ],
  [
    ['red', ' FAIL '],
    ['foreground', 'src/scheme.test.ts'],
  ],
  [
    ['yellow', ' WARN '],
    ['brightBlack', '2 deprecated packages'],
  ],
]

function TerminalSample({ scheme, font }: { scheme: ColorScheme; font: string }): JSX.Element {
  const { colors } = scheme
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-2 px-3 py-2.5 text-ui-xs"
      style={{ background: colors.background, fontFamily: font }}
    >
      <div>
        {TERMINAL_LINES.map((line) => (
          <div
            key={line.map(([, text]) => text).join('')}
            className="overflow-hidden text-ellipsis whitespace-pre"
          >
            {line.map(([key, text]) => (
              <span key={text} style={{ color: colors[key] }}>
                {text}
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="grid w-max grid-cols-8 gap-0.5">
        {ANSI_NAMES.map((name) => (
          <span key={name} className="size-3 rounded-[2px]" style={{ background: colors[name] }} />
        ))}
      </div>
    </div>
  )
}

const CODE_LINES: [keyof CodeColors, string][][] = [
  [
    ['keyword', 'export function '],
    ['function', 'pick'],
    ['delimiter', '('],
    ['variable', 'id'],
    ['delimiter', ': '],
    ['type', 'string'],
    ['delimiter', ') {'],
  ],
  [
    ['keyword', '  const '],
    ['variable', 'found '],
    ['operator', '= '],
    ['variable', 'schemes'],
    ['delimiter', '.'],
    ['function', 'find'],
    ['delimiter', '(('],
    ['variable', 's'],
    ['delimiter', ') '],
    ['operator', '=> '],
    ['variable', 's'],
    ['delimiter', '.'],
    ['text', 'id '],
    ['operator', '=== '],
    ['variable', 'id'],
    ['delimiter', ')'],
  ],
  [
    ['keyword', '  return '],
    ['variable', 'found '],
    ['operator', '?? '],
    ['string', "'adeberry'"],
  ],
  [['delimiter', '}']],
  [
    ['keyword', 'const '],
    ['variable', 'retries '],
    ['operator', '= '],
    ['number', '3'],
  ],
]

function EditorSample({ scheme, font }: { scheme: ColorScheme; font: string }): JSX.Element {
  const code = codeColors(scheme)
  const monaco = monacoThemeData(scheme).colors
  return (
    <div
      className="min-w-0 flex-1 py-2.5 pr-3 text-ui-xs"
      style={{ background: scheme.colors.background, fontFamily: font }}
    >
      {CODE_LINES.map((line, index) => (
        <div key={line.map(([, text]) => text).join('')} className="flex whitespace-pre">
          <span
            className="w-7 shrink-0 pr-2 text-right"
            style={{ color: monaco['editorLineNumber.foreground'] }}
          >
            {index + 1}
          </span>
          <span className="overflow-hidden text-ellipsis whitespace-pre">
            {line.map(([key, text], i) => (
              <span key={`${i}-${text}`} style={{ color: code[key] }}>
                {text}
              </span>
            ))}
          </span>
        </div>
      ))}
    </div>
  )
}

function PreviewTab({ label, active }: { label: string; active: boolean }): JSX.Element {
  return (
    <span
      className={
        active
          ? 'bg-surface-1 px-2.5 py-1 text-fg text-ui-xs shadow-[inset_0_2px_0_var(--brand)]'
          : 'px-2.5 py-1 text-fg-muted text-ui-xs'
      }
    >
      {label}
    </span>
  )
}

export function ThemePreview(): JSX.Element {
  const d = useDict()
  const theme = useEffectiveTheme()
  const terminal = useScheme('terminal')
  const editor = useScheme('editor')
  const terminalFont = useSettingsStore((s) => s.appearance.terminal.family)
  const editorFont = useSettingsStore((s) => s.appearance.editor.family)
  const label = fmt(d.settings.themePreview, {
    product: PRODUCT_NAME,
    theme: theme?.name ?? '',
    terminal: terminal.name,
    editor: editor.name,
  })
  return (
    <figure
      aria-label={label}
      data-testid="theme-preview"
      className="my-2 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-line bg-line"
    >
      <div className="flex min-w-0 flex-col" data-preview="terminal">
        <div className="flex bg-bg-sunken">
          <PreviewTab label="zsh" active />
          <PreviewTab label="claude" active={false} />
        </div>
        <TerminalSample scheme={terminal} font={`"${terminalFont}", monospace`} />
      </div>
      <div className="flex min-w-0 flex-col" data-preview="editor">
        <div className="flex bg-bg-sunken">
          <PreviewTab label="pick.ts" active={false} />
        </div>
        <EditorSample scheme={editor} font={`"${editorFont}", monospace`} />
      </div>
    </figure>
  )
}

export function ThemeRows(): JSX.Element {
  const d = useDict()
  const themes = usePluginsStore((s) => s.themes)
  const theme = useSettingsStore((s) => s.appearance.theme)
  const setTheme = useSettingsStore((s) => s.setTheme)
  const followSystem = useSettingsStore((s) => s.appearance.followSystem)
  const setFollowSystem = useSettingsStore((s) => s.setFollowSystem)
  const lightTheme = useSettingsStore((s) => s.appearance.lightTheme)
  const setLightTheme = useSettingsStore((s) => s.setLightTheme)
  const darkTheme = useSettingsStore((s) => s.appearance.darkTheme)
  const setDarkTheme = useSettingsStore((s) => s.setDarkTheme)
  const options = (appearance?: 'light' | 'dark') =>
    themes
      .filter((t) => !appearance || t.appearance === appearance)
      .map((t) => ({ value: t.id, label: t.name }))
  const product = { product: PRODUCT_NAME }
  return (
    <>
      <ToggleRow
        label={d.settings.followSystem}
        desc={d.settings.followSystemDesc}
        checked={followSystem}
        onChange={setFollowSystem}
      />
      {followSystem ? (
        <>
          <ControlRow label={d.settings.lightTheme}>
            <SelectField
              value={lightTheme}
              onChange={setLightTheme}
              label={d.settings.lightTheme}
              options={options('light')}
            />
          </ControlRow>
          <ControlRow label={d.settings.darkTheme}>
            <SelectField
              value={darkTheme}
              onChange={setDarkTheme}
              label={d.settings.darkTheme}
              options={options('dark')}
            />
          </ControlRow>
        </>
      ) : (
        <ControlRow
          label={fmt(d.settings.productTheme, product)}
          desc={fmt(d.settings.productThemeDesc, product)}
        >
          <SelectField
            value={theme}
            onChange={setTheme}
            label={fmt(d.settings.productTheme, product)}
            options={options()}
          />
        </ControlRow>
      )}
      <SchemeRow surface="terminal" />
      <SchemeRow surface="editor" />
      <ThemePreview />
    </>
  )
}
