import {
  type AutoSaveMode,
  type LineNumberMode,
  OPEN_FILES_IN,
  type OpenFilesIn,
  SEARCH_ENGINES,
  type SearchEngine,
  TAB_WIDTHS,
  type TabWidth,
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  isValidSearchTemplate,
} from '@shared/browserEditorSettings'
import { useState } from 'react'
import { useDict } from '../i18n/useDict'
import { useSettingsStore } from '../stores/settingsStore'
import {
  ControlRow,
  SectionHead,
  SelectField,
  SettingsGroup,
  ToggleRow,
  WarningNote,
} from './SettingsPanel'
import { Input } from './ui/input'

function ZoomField(): JSX.Element {
  const d = useDict()
  const zoom = useSettingsStore((s) => s.browser.defaultZoom)
  const setBrowser = useSettingsStore((s) => s.setBrowser)
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft !== null && draft.trim() !== '') setBrowser({ defaultZoom: clampZoom(Number(draft)) })
    setDraft(null)
  }
  return (
    <Input
      type="number"
      min={ZOOM_MIN}
      max={ZOOM_MAX}
      step={10}
      value={draft ?? String(zoom)}
      aria-label={d.browserSettings.defaultZoom}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
      }}
      className="h-7 w-24"
    />
  )
}

export function BrowserSettingsSection(): JSX.Element {
  const d = useDict()
  const browser = useSettingsStore((s) => s.browser)
  const setBrowser = useSettingsStore((s) => s.setBrowser)
  const engineLabel: Record<SearchEngine, string> = {
    google: d.browserSettings.google,
    duckduckgo: d.browserSettings.duckduckgo,
    bing: d.browserSettings.bing,
    kagi: d.browserSettings.kagi,
    custom: d.browserSettings.custom,
  }
  const custom = browser.searchEngine === 'custom'
  return (
    <div>
      <SectionHead title={d.browserSettings.title} />
      <SettingsGroup title={d.browserSettings.groupSearch}>
        <ControlRow
          label={d.browserSettings.searchEngine}
          desc={d.browserSettings.searchEngineDesc}
        >
          <SelectField
            value={browser.searchEngine}
            onChange={(searchEngine) => setBrowser({ searchEngine })}
            label={d.browserSettings.searchEngine}
            options={SEARCH_ENGINES.map((e) => ({ value: e, label: engineLabel[e] }))}
          />
        </ControlRow>
        {custom ? (
          <>
            <ControlRow label={d.browserSettings.customUrl} desc={d.browserSettings.customUrlDesc}>
              <Input
                value={browser.customSearchUrl}
                spellCheck={false}
                aria-label={d.browserSettings.customUrl}
                placeholder="https://example.com/search?q={query}"
                onChange={(e) => setBrowser({ customSearchUrl: e.target.value })}
                className="h-7 w-72 font-mono"
              />
            </ControlRow>
            {isValidSearchTemplate(browser.customSearchUrl) ? null : (
              <WarningNote>{d.browserSettings.customUrlInvalid}</WarningNote>
            )}
          </>
        ) : null}
      </SettingsGroup>
      <SettingsGroup title={d.browserSettings.groupLinks}>
        <ToggleRow
          label={d.browserSettings.openTerminalLinks}
          desc={d.browserSettings.openTerminalLinksDesc}
          checked={browser.openTerminalLinks}
          onChange={(openTerminalLinks) => setBrowser({ openTerminalLinks })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.browserSettings.groupPage}>
        <ControlRow label={d.browserSettings.defaultZoom} desc={d.browserSettings.defaultZoomDesc}>
          <ZoomField />
        </ControlRow>
      </SettingsGroup>
    </div>
  )
}

export function EditorSettingsSection(): JSX.Element {
  const d = useDict()
  const editor = useSettingsStore((s) => s.editor)
  const setEditor = useSettingsStore((s) => s.setEditor)
  const numbersLabel: Record<LineNumberMode, string> = {
    on: d.editorSettings.lineNumbersOn,
    off: d.editorSettings.lineNumbersOff,
    relative: d.editorSettings.lineNumbersRelative,
  }
  const autoSaveLabel: Record<AutoSaveMode, string> = {
    off: d.editorSettings.autoSaveOff,
    afterDelay: d.editorSettings.autoSaveAfterDelay,
    onFocusChange: d.editorSettings.autoSaveOnFocusChange,
  }
  const openInLabel: Record<OpenFilesIn, string> = {
    tab: d.editorSettings.openFilesInTab,
    split: d.editorSettings.openFilesInSplit,
  }
  return (
    <div>
      <SectionHead title={d.editorSettings.title} />
      <SettingsGroup title={d.editorSettings.groupView}>
        <ControlRow label={d.editorSettings.openFilesIn} desc={d.editorSettings.openFilesInDesc}>
          <SelectField
            value={editor.openFilesIn}
            onChange={(openFilesIn) => setEditor({ openFilesIn })}
            label={d.editorSettings.openFilesIn}
            options={OPEN_FILES_IN.map((m) => ({ value: m, label: openInLabel[m] }))}
          />
        </ControlRow>
        <ToggleRow
          label={d.editorSettings.wordWrap}
          desc={d.editorSettings.wordWrapDesc}
          checked={editor.wordWrap === 'on'}
          onChange={(on) => setEditor({ wordWrap: on ? 'on' : 'off' })}
        />
        <ControlRow label={d.editorSettings.lineNumbers}>
          <SelectField
            value={editor.lineNumbers}
            onChange={(lineNumbers) => setEditor({ lineNumbers })}
            label={d.editorSettings.lineNumbers}
            options={(Object.keys(numbersLabel) as LineNumberMode[]).map((m) => ({
              value: m,
              label: numbersLabel[m],
            }))}
          />
        </ControlRow>
      </SettingsGroup>
      <SettingsGroup title={d.editorSettings.groupIndent}>
        <ControlRow label={d.editorSettings.tabSize} desc={d.editorSettings.tabSizeDesc}>
          <SelectField
            value={String(editor.tabSize)}
            onChange={(v) => setEditor({ tabSize: Number(v) as TabWidth })}
            label={d.editorSettings.tabSize}
            options={TAB_WIDTHS.map((w) => ({ value: String(w), label: String(w) }))}
          />
        </ControlRow>
        <ToggleRow
          label={d.editorSettings.insertSpaces}
          desc={d.editorSettings.insertSpacesDesc}
          checked={editor.insertSpaces}
          onChange={(insertSpaces) => setEditor({ insertSpaces })}
        />
      </SettingsGroup>
      <SettingsGroup title={d.editorSettings.groupSave}>
        <ControlRow label={d.editorSettings.autoSave} desc={d.editorSettings.autoSaveDesc}>
          <SelectField
            value={editor.autoSave}
            onChange={(autoSave) => setEditor({ autoSave })}
            label={d.editorSettings.autoSave}
            options={(Object.keys(autoSaveLabel) as AutoSaveMode[]).map((m) => ({
              value: m,
              label: autoSaveLabel[m],
            }))}
          />
        </ControlRow>
        <ToggleRow
          label={d.editorSettings.formatOnSave}
          desc={d.editorSettings.formatOnSaveDesc}
          checked={editor.formatOnSave}
          onChange={(formatOnSave) => setEditor({ formatOnSave })}
        />
      </SettingsGroup>
    </div>
  )
}
