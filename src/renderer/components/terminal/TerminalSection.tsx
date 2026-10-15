import { TextLink } from '@/components/common/TextLink'
import {
  ControlRow,
  ExperimentalBadge,
  ToggleRow,
  WarningNote,
} from '@/components/settings/ControlRow'
import { DiscreteGpuRow } from '@/components/settings/DiscreteGpuRow'
import { RequirementsNoteView, useRequirements } from '@/components/settings/RequirementsNote'
import { SelectField } from '@/components/settings/SelectField'
import { SectionHead, SettingsGroup } from '@/components/settings/SettingsGroup'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import type { ClipboardKeys, TerminalRenderer } from '@/lib/settings/terminalPaneSettings'
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  TERMINAL_RENDERERS,
} from '@/lib/settings/terminalPaneSettings'
import { ghosttyFailure } from '@/lib/terminal/ghosttyEngine'
import { isLinux, isMac } from '@/platform'
import {
  CURSOR_STYLES,
  type CursorStyle,
  INPUT_MODES,
  type InputMode,
} from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'
import { CaretRightIcon } from '@phosphor-icons/react'
import { KEEP_SHELLS_FEATURE, TMUX_MIN_VERSION } from '@shared/terminal/keepShells'
import { useEffect, useState } from 'react'

export function TerminalSection(): JSX.Element {
  const d = useDict()
  return (
    <div>
      <SectionHead title={d.settings.terminal} />
      <TerminalInputGroup />
      {isMac ? <TerminalKeyboardGroup /> : null}
      <TerminalCursorGroup />
      <TerminalSelectionGroup />
      <TerminalScrollingGroup />
      <TerminalPasteGroup />
      <TerminalColorsGroup />
      <TerminalRenderingGroup />
      <TerminalSessionGroup />
    </div>
  )
}

function TerminalInputGroup(): JSX.Element {
  const d = useDict()
  const mode = useSettingsStore((s) => s.behavior.inputMode)
  const vim = useSettingsStore((s) => s.behavior.inputEditorVim)
  const historySuggestions = useSettingsStore((s) => s.behavior.historySuggestions)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const promptStyle = useSettingsStore((s) => s.terminal.prompt.style)
  const modeLabel: Record<InputMode, string> = {
    terminal: d.settings.inputModeTerminal,
    editor: d.settings.inputModeEditor,
  }
  return (
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
  )
}

function TerminalKeyboardGroup(): JSX.Element {
  const d = useDict()
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const macOptionIsMeta = useSettingsStore((s) => s.terminal.macOptionIsMeta)
  return (
    <SettingsGroup title={d.settings.groupKeyboard}>
      <ToggleRow
        label={d.settings.macOptionIsMeta}
        desc={d.settings.macOptionIsMetaDesc}
        checked={macOptionIsMeta}
        onChange={(v) => setTerminal({ macOptionIsMeta: v })}
      />
    </SettingsGroup>
  )
}

function TerminalCursorGroup(): JSX.Element {
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
  )
}

function TerminalSelectionGroup(): JSX.Element {
  const d = useDict()
  const copyOnSelect = useSettingsStore((s) => s.behavior.copyOnSelect)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  return (
    <SettingsGroup title={d.settings.groupSelection}>
      <ToggleRow
        label={d.settings.copyOnSelect}
        desc={d.settings.copyOnSelectDesc}
        checked={copyOnSelect}
        onChange={(v) => setBehavior({ copyOnSelect: v })}
      />
    </SettingsGroup>
  )
}

function TerminalScrollingGroup(): JSX.Element {
  const d = useDict()
  const wheelZoom = useSettingsStore((s) => s.behavior.wheelZoom)
  const smoothScrolling = useSettingsStore((s) => s.behavior.smoothScrolling)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const scrollSpeed = useSettingsStore((s) => s.terminal.scrollSpeed)
  const scrollbackLines = useSettingsStore((s) => s.terminal.scrollbackLines)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  return (
    <SettingsGroup title={d.settings.groupScrolling}>
      <ToggleRow
        label={isMac ? d.settings.wheelZoomMac : d.settings.wheelZoom}
        desc={d.settings.wheelZoomDesc}
        checked={wheelZoom}
        onChange={(v) => setBehavior({ wheelZoom: v })}
      />
      <ToggleRow
        label={d.settings.smoothScrolling}
        desc={d.settings.smoothScrollingDesc}
        checked={smoothScrolling}
        onChange={(v) => setBehavior({ smoothScrolling: v })}
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
  )
}

function TerminalPasteGroup(): JSX.Element {
  const d = useDict()
  const warnOnRiskyPaste = useSettingsStore((s) => s.terminal.warnOnRiskyPaste)
  const clipboardKeys = useSettingsStore((s) => s.terminal.clipboardKeys)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const osc52Write = useSettingsStore((s) => s.terminal.osc52Write)
  const primarySelection = useSettingsStore((s) => s.terminal.primarySelection)
  return (
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
  )
}

function TerminalColorsGroup(): JSX.Element {
  const d = useDict()
  const minimumContrast = useSettingsStore((s) => s.terminal.minimumContrast)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  return (
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
  )
}

function TerminalRenderingGroup(): JSX.Element {
  const d = useDict()
  const gpuAcceleration = useSettingsStore((s) => s.behavior.gpuAcceleration)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const renderer = useSettingsStore((s) => s.terminal.renderer)
  const rendererLabel: Record<TerminalRenderer, string> = {
    xterm: d.settings.rendererXterm,
    ghostty: d.settings.rendererGhostty,
  }
  return (
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
  )
}

function TerminalSessionGroup(): JSX.Element {
  const d = useDict()
  const restoreWorkspace = useSettingsStore((s) => s.behavior.restoreWorkspace)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const shell = useSettingsStore((s) => s.terminal.shell)
  const keepShells = useSettingsStore((s) => s.terminal.keepShells)
  const keepShellsRequirements = useRequirements(KEEP_SHELLS_FEATURE)
  const keepShellsReport = keepShellsRequirements.report
  return (
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
