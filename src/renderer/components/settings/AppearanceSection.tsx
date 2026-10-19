import { Hint } from '@/components/common/Hint'
import { CommitInput, NumberInput } from '@/components/settingsKit/CommitInput'
import { ControlRow } from '@/components/settingsKit/ControlRow'
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
  FONT_WEIGHTS,
  type FontSurface,
  LINE_HEIGHT_MAX,
  LINE_HEIGHT_MIN,
  MOTION_MODES,
  type MotionMode,
  motionMode,
} from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { PRODUCT_PLACEHOLDER } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { PlusIcon } from '@phosphor-icons/react'
import { ZOOM_MAX, ZOOM_MIN, ZOOM_STEP } from '@shared/app/zoom'
import { useState } from 'react'
import { FontPicker } from './FontPicker'
import { ThemeRows } from './ThemeSettings'

export function AppearanceSection(): JSX.Element {
  const d = useDict()
  const motion = useSettingsStore((s) => s.appearance.motion)
  const setMotion = useSettingsStore((s) => s.setMotion)
  const motionLabel: Record<MotionMode, string> = {
    system: d.settings.motionSystem,
    reduced: d.settings.motionReduced,
    full: d.settings.motionFull,
  }
  return (
    <SettingsPage title={d.settings.appearance}>
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
    </SettingsPage>
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
        key={accent}
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
      <NumberInput
        min={8}
        max={32}
        value={font.size}
        aria-label={fmt(d.settings.fontSizeFor, { label })}
        onCommit={(n) => setSurfaceFont(surface, { size: Math.round(n) })}
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
      <NumberInput
        min={LINE_HEIGHT_MIN}
        max={LINE_HEIGHT_MAX}
        step={0.05}
        value={lineHeight}
        aria-label={d.settings.lineHeight}
        onCommit={setLineHeight}
        className="h-7 w-20 font-mono"
      />
    </ControlRow>
  )
}
