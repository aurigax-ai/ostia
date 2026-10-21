import { PRODUCT_PLACEHOLDER } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PlusIcon } from '@phosphor-icons/react'
import type { Dict, Locale } from '@shared/app/dict'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@shared/app/zoom'
import { useState } from 'react'
import { Hint } from '@/components/common/Hint'
import { TextLink } from '@/components/common/TextLink'
import { CommitInput, NumberInput } from '@/components/settingsKit/CommitInput'
import { ControlRow } from '@/components/settingsKit/ControlRow'
import { Field, FieldLine } from '@/components/settingsKit/FieldLine'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Button } from '@/components/ui/button'
import { fmt, useDict } from '@/lib/app/useDict'
import { WINDOW_TITLE_MAX } from '@/lib/settings/windowTitle'
import { ACCENT_PRESETS, normalizeHex } from '@/lib/theme/color'
import { useEffectiveTheme } from '@/lib/theme/theme'
import { cn } from '@/lib/utils'
import {
  DEFAULTS,
  FONT_WEIGHTS,
  type FontSurface,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MOTION_MODES,
  type MotionMode,
  motionMode,
} from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { usePluginsStore } from '@/stores/extensions/pluginsStore'
import { FontPicker } from './FontPicker'
import { ThemeRows } from './ThemeSettings'

export function AppearanceSection(): JSX.Element {
  const d = useDict()
  return (
    <SettingsPage title={d.settings.appearance}>
      <SettingsGroup title={d.settings.groupTheme}>
        <ThemeRows />
        <AccentRow />
        <MotionRow />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupText}>
        <FontLine surface="terminal" label={d.settings.terminalFont} />
        <FontLine surface="ui" label={d.settings.uiFont} desc={d.settings.uiFontDesc} />
        <FontLine surface="editor" label={d.settings.editorFont} desc={d.settings.editorFontDesc} />
      </SettingsGroup>
      <SettingsGroup title={d.settings.groupWindow}>
        <ZoomRow />
        <WindowTitleRow />
        <DisplayLanguageRow />
      </SettingsGroup>
    </SettingsPage>
  )
}

function MotionRow(): JSX.Element {
  const d = useDict()
  const motion = useSettingsStore((s) => s.appearance.motion)
  const setMotion = useSettingsStore((s) => s.setMotion)
  const motionLabel: Record<MotionMode, string> = {
    system: d.settings.motionSystem,
    reduced: d.settings.motionReduced,
    full: d.settings.motionFull,
  }
  return (
    <ControlRow label={d.settings.motion} desc={d.settings.motionDesc}>
      <SelectField
        value={motionMode(motion)}
        onChange={setMotion}
        label={d.settings.motion}
        options={MOTION_MODES.map((m) => ({ value: m, label: motionLabel[m] }))}
      />
    </ControlRow>
  )
}

function DisplayLanguageRow(): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const setLocale = useSettingsStore((s) => s.setLocale)
  const languages = usePluginsStore((s) => s.languages)
  return (
    <ControlRow label={d.settings.displayLanguage}>
      <SelectField
        value={locale}
        onChange={(l) => setLocale(l as Locale)}
        label={d.settings.displayLanguage}
        options={languages.map((l) => ({ value: l.id, label: l.label }))}
      />
    </ControlRow>
  )
}

function WindowTitleRow(): JSX.Element {
  const d = useDict()
  const template = useSettingsStore((s) => s.appearance.windowTitle)
  const setWindowTitle = useSettingsStore((s) => s.setWindowTitle)
  return (
    <ControlRow
      label={d.settings.windowTitle}
      desc={fmt(d.settings.windowTitleDesc, { productPlaceholder: PRODUCT_PLACEHOLDER })}
    >
      <CommitInput
        value={template}
        spellCheck={false}
        maxLength={WINDOW_TITLE_MAX}
        aria-label={d.settings.windowTitle}
        className="h-7 w-56 font-mono text-ui-sm"
        onCommit={setWindowTitle}
      />
    </ControlRow>
  )
}

function AccentRow(): JSX.Element {
  const d = useDict()
  const accent = useSettingsStore((s) => s.appearance.accent)
  const setAccent = useSettingsStore((s) => s.setAccent)
  const [rejectedAt, setRejectedAt] = useState<string | null>(null)
  const invalid = rejectedAt === accent
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
            className="size-5 rounded-full border border-line-strong outline-offset-2 aria-pressed:outline-2 aria-pressed:outline-fg"
          />
        ))}
        <Hint label={d.settings.accentCustom}>
          <label
            data-testid="accent-custom"
            data-selected={custom || undefined}
            data-focus-ring="within"
            style={custom ? { background: accent } : undefined}
            className={cn(
              'relative flex size-5 items-center justify-center rounded-full border outline-offset-2',
              custom
                ? 'border-line-strong outline-2 outline-fg'
                : 'border-line-strong border-dashed text-fg-muted hover:text-fg',
            )}
          >
            {custom ? null : <PlusIcon size={16} aria-hidden />}
            <input
              type="color"
              aria-label={d.settings.accentCustom}
              value={custom ? accent : themeBrand}
              onChange={(e) => setAccent(e.target.value)}
              className="absolute inset-0 size-full opacity-0 outline-none"
            />
          </label>
        </Hint>
      </div>
      <CommitInput
        value={accent}
        spellCheck={false}
        placeholder="#rrggbb"
        aria-label={d.settings.accentHex}
        aria-invalid={invalid}
        aria-describedby={invalid ? 'accent-hex-error' : undefined}
        onCommit={(text) => {
          const accepted = setAccent(text)
          setRejectedAt(accepted ? null : accent)
          return accepted
        }}
        onCancel={() => setRejectedAt(null)}
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
  return (
    <ControlRow label={d.settings.zoom} desc={d.settings.zoomDesc}>
      <NumberInput
        min={ZOOM_MIN}
        max={ZOOM_MAX}
        step={ZOOM_STEP}
        value={zoom}
        aria-label={d.settings.zoom}
        onCommit={setZoom}
        className="h-7 w-20 font-mono"
      />
      <span className="text-fg-muted text-ui-sm">%</span>
    </ControlRow>
  )
}

function weightName(d: Dict, weight: number): string {
  const names: Record<number, string> = {
    300: d.settings.weights.light,
    400: d.settings.weights.regular,
    450: d.settings.weights.book,
    500: d.settings.weights.medium,
    600: d.settings.weights.semibold,
    700: d.settings.weights.bold,
  }
  return names[weight] ?? String(weight)
}

function ResetLink({
  label,
  value,
  onReset,
}: {
  label: string
  value: string
  onReset: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <TextLink
      size="xs"
      className="h-4 px-0 text-ui-xs"
      aria-label={fmt(d.settings.resetFor, { label, value })}
      onClick={onReset}
    >
      {fmt(d.settings.resetTo, { value })}
    </TextLink>
  )
}

function FontLine({
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
  const lineHeight = useSettingsStore((s) => s.appearance.terminal.lineHeight)
  const setSurfaceFont = useSettingsStore((s) => s.setSurfaceFont)
  const setLineHeight = useSettingsStore((s) => s.setTerminalLineHeight)
  const initial = DEFAULTS.appearance[surface]
  const initialLineHeight = DEFAULTS.appearance.terminal.lineHeight
  return (
    <FieldLine label={label} desc={desc}>
      <Field
        label={d.settings.fieldFont}
        reset={
          font.family === initial.family ? null : (
            <ResetLink
              label={fmt(d.settings.fontFamilyFor, { label })}
              value={initial.family}
              onReset={() => setSurfaceFont(surface, { family: initial.family })}
            />
          )
        }
      >
        <FontPicker
          value={font.family}
          label={fmt(d.settings.fontFamilyFor, { label })}
          onChange={(family) => setSurfaceFont(surface, { family })}
        />
      </Field>
      <Field
        label={d.settings.fieldWeight}
        reset={
          font.weight === initial.weight ? null : (
            <ResetLink
              label={fmt(d.settings.fontWeightFor, { label })}
              value={weightName(d, initial.weight)}
              onReset={() => setSurfaceFont(surface, { weight: initial.weight })}
            />
          )
        }
      >
        <SelectField
          value={String(font.weight)}
          onChange={(w) => setSurfaceFont(surface, { weight: Number(w) })}
          label={fmt(d.settings.fontWeightFor, { label })}
          width="w-28"
          options={FONT_WEIGHTS.map((w) => ({ value: String(w), label: weightName(d, w) }))}
        />
      </Field>
      <Field
        label={d.settings.fieldSize}
        reset={
          font.size === initial.size ? null : (
            <ResetLink
              label={fmt(d.settings.fontSizeFor, { label })}
              value={String(initial.size)}
              onReset={() => setSurfaceFont(surface, { size: initial.size })}
            />
          )
        }
      >
        <NumberInput
          min={8}
          max={32}
          value={font.size}
          aria-label={fmt(d.settings.fontSizeFor, { label })}
          onCommit={(n) => setSurfaceFont(surface, { size: Math.round(n) })}
          className="h-7 w-16 font-mono"
        />
      </Field>
      {surface === 'terminal' ? (
        <Field
          label={d.settings.fieldLineHeight}
          reset={
            lineHeight === initialLineHeight ? null : (
              <ResetLink
                label={d.settings.lineHeight}
                value={String(initialLineHeight)}
                onReset={() => setLineHeight(initialLineHeight)}
              />
            )
          }
        >
          <NumberInput
            min={LINE_HEIGHT_MIN}
            max={LINE_HEIGHT_MAX}
            step={0.05}
            value={lineHeight}
            aria-label={d.settings.lineHeight}
            onCommit={setLineHeight}
            className="h-7 w-20 font-mono"
          />
        </Field>
      ) : null}
    </FieldLine>
  )
}
