import { CaretRightIcon } from '@phosphor-icons/react'
import { KEEP_SHELLS_FEATURE, TMUX_MIN_VERSION } from '@shared/terminal/keepShells'
import {
  SCROLLBACK_HISTORY_MAX_MIB,
  SCROLLBACK_HISTORY_MIN_MIB,
} from '@shared/terminal/scrollbackHistory'
import { Notice } from '@/components/common/Notice'
import { TextLink } from '@/components/common/TextLink'
import { DiscreteGpuRow } from '@/components/settings/DiscreteGpuRow'
import { RequirementsNoteView, useRequirements } from '@/components/settings/RequirementsNote'
import { NumberInput } from '@/components/settingsKit/CommitInput'
import {
  ControlRow,
  ExperimentalBadge,
  NumberRow,
  ToggleRow,
} from '@/components/settingsKit/ControlRow'
import { SelectField } from '@/components/settingsKit/SelectField'
import { SettingsGroup } from '@/components/settingsKit/SettingsGroup'
import { SettingsPage } from '@/components/settingsKit/SettingsPage'
import { Input } from '@/components/ui/input'
import { fmt, useDict } from '@/lib/app/useDict'
import type { ClipboardKeys, TerminalRenderer } from '@/lib/settings/terminalPaneSettings'
import {
  CONTRAST_MAX,
  CONTRAST_MIN,
  SCROLL_SPEED_MAX,
  SCROLL_SPEED_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  TERMINAL_RENDERERS,
} from '@/lib/settings/terminalPaneSettings'
import { ghosttyFailure } from '@/lib/terminal/ghosttyEngine'
import { isLinux, isMac } from '@/platform'
import {
  CURSOR_STYLES,
  type CursorStyle,
  INPUT_ESCAPES,
  INPUT_MODES,
  type InputEscape,
  type InputMode,
} from '@/stores/app/settingsModel'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useUIStore } from '@/stores/app/uiStore'

export function TerminalSection(): JSX.Element {
  const d = useDict()
  return (
    <SettingsPage title={d.settings.terminal}>
      <TerminalInputGroup />
      {isMac ? <TerminalKeyboardGroup /> : null}
      <TerminalCursorGroup />
      <TerminalSelectionGroup />
      <TerminalScrollingGroup />
      <TerminalPasteGroup />
      <TerminalColorsGroup />
      <TerminalRenderingGroup />
      <TerminalSessionGroup />
    </SettingsPage>
  )
}

function TerminalInputGroup(): JSX.Element {
  const d = useDict()
  const mode = useSettingsStore((s) => s.behavior.inputMode)
  const vim = useSettingsStore((s) => s.behavior.inputEditorVim)
  const escKey = useSettingsStore((s) => s.behavior.inputEscape)
  const liveFiles = useSettingsStore((s) => s.behavior.liveFileSuggestions)
  const historySuggestions = useSettingsStore((s) => s.behavior.historySuggestions)
  const setBehavior = useSettingsStore((s) => s.setBehavior)
  const promptStyle = useSettingsStore((s) => s.terminal.prompt.style)
  const modeLabel: Record<InputMode, string> = {
    terminal: d.settings.inputModeTerminal,
    editor: d.settings.inputModeEditor,
  }
  const escapeLabel: Record<InputEscape, string> = {
    clear: d.settings.inputEscapeClear,
    menus: d.settings.inputEscapeMenus,
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
      <ControlRow label={d.settings.inputEscape} desc={d.settings.inputEscapeDesc}>
        <SelectField
          value={escKey}
          onChange={(v) => setBehavior({ inputEscape: v })}
          label={d.settings.inputEscape}
          options={INPUT_ESCAPES.map((v) => ({ value: v, label: escapeLabel[v] }))}
        />
      </ControlRow>
      <ToggleRow
        label={d.settings.liveFileSuggestions}
        desc={d.settings.liveFileSuggestionsDesc}
        checked={liveFiles}
        onChange={(v) => setBehavior({ liveFileSuggestions: v })}
      />
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
        <Notice>{d.settings.promptNeedsEditor}</Notice>
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
  const wheelSmoothScroll = useSettingsStore((s) => s.behavior.wheelSmoothScroll)
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
        label={d.settings.wheelSmoothScroll}
        desc={d.settings.wheelSmoothScrollDesc}
        checked={wheelSmoothScroll}
        onChange={(v) => setBehavior({ wheelSmoothScroll: v })}
      />
      <NumberRow
        label={d.settings.scrollSpeed}
        desc={d.settings.scrollSpeedDesc}
        value={scrollSpeed}
        min={SCROLL_SPEED_MIN}
        max={SCROLL_SPEED_MAX}
        step={0.1}
        onCommit={(v) => setTerminal({ scrollSpeed: v })}
      />
      <NumberRow
        label={d.settings.scrollbackLines}
        desc={d.settings.scrollbackLinesDesc}
        value={scrollbackLines}
        min={SCROLLBACK_MIN}
        max={SCROLLBACK_MAX}
        step={1000}
        onCommit={(v) => setTerminal({ scrollbackLines: v })}
      />
      <HistoryOnDiskRow />
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
      <NumberRow
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
        <Notice>{fmt(d.settings.ghosttyFailed, { reason: ghosttyFailure() ?? '' })}</Notice>
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

const HISTORY_LIMIT_DEFAULT_MIB = 1024

function HistoryOnDiskRow(): JSX.Element {
  const d = useDict()
  const value = useSettingsStore((s) => s.terminal.scrollbackHistory)
  const setTerminal = useSettingsStore((s) => s.setTerminal)
  const mode = typeof value === 'number' ? 'limit' : value
  return (
    <ControlRow label={d.settings.scrollbackHistory} desc={d.settings.scrollbackHistoryDesc}>
      <div className="flex items-center gap-2">
        <SelectField
          value={mode}
          onChange={(v) =>
            setTerminal({
              scrollbackHistory:
                v === 'limit' ? HISTORY_LIMIT_DEFAULT_MIB : (v as 'off' | 'unlimited'),
            })
          }
          label={d.settings.scrollbackHistory}
          options={[
            { value: 'unlimited', label: d.settings.scrollbackHistoryUnlimited },
            { value: 'limit', label: d.settings.scrollbackHistoryLimit },
            { value: 'off', label: d.settings.scrollbackHistoryOff },
          ]}
        />
        {typeof value === 'number' ? (
          <NumberInput
            min={SCROLLBACK_HISTORY_MIN_MIB}
            max={SCROLLBACK_HISTORY_MAX_MIB}
            step={256}
            value={value}
            aria-label={d.settings.scrollbackHistoryMib}
            title={d.settings.scrollbackHistoryMib}
            onCommit={(n) => setTerminal({ scrollbackHistory: n })}
            className="h-7 w-24 font-mono"
          />
        ) : null}
      </div>
    </ControlRow>
  )
}
