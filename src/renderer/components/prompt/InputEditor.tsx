import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { useDict } from '@/lib/app/useDict'
import { useChipCatalog } from '@/lib/extensions/extensionChips'
import { usePromptChips } from '@/lib/prompt/usePromptChips'
import { usePromptGeometry } from '@/lib/prompt/usePromptGeometry'
import type { VimMode } from '@/lib/prompt/vimMode'
import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import type { TerminalColors } from '@/lib/theme/types'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { type LineAnchor, useBlocksStore } from '@/stores/terminal/blocksStore'
import { InputEditorField } from './InputEditorField'
import { InputEditorGhostMenu } from './InputEditorGhostMenu'
import { InputEditorMenu } from './InputEditorMenu'
import { PromptChipRow } from './PromptChips'
import { useInputCompletion } from './useInputCompletion'
import { useInputDraft } from './useInputDraft'
import { useInputEditorKeys } from './useInputEditorKeys'
import { useInputHistory } from './useInputHistory'
import { useInputLayout } from './useInputLayout'
import { useInputSuggestions } from './useInputSuggestions'
import { useInputVim } from './useInputVim'

export interface InputEditorProps {
  paneId: string
  cwd?: string
  fontFamily: string
  fontSize: number
  palette?: TerminalColors
  alternateScreen: boolean
  paneShown: boolean
  suppressedPrompt: LineAnchor | null
  termRef: RefObject<Xterm | null>
  hostRef: RefObject<HTMLElement | null>
  ownsFocus: () => boolean
  onSubmit: (text: string) => boolean
  onHandOff: (draft: string, keys: string) => void
  onShellKeys: (keys: string) => void
  onNeedRows: (rows: number) => void
}

function useInputEditorVisible(
  paneId: string,
  alternateScreen: boolean,
  suppressedPrompt: LineAnchor | null,
): boolean {
  const mode = useSettingsStore((s) => s.behavior.inputMode)
  const promptLine = useBlocksStore((s) => s.drafts[paneId]?.promptLine)
  const running = useBlocksStore((s) => Boolean(s.running[paneId]))
  const remote = useBlocksStore((s) => s.drafts[paneId]?.remote === true)
  return (
    mode === 'editor' &&
    Boolean(promptLine) &&
    !running &&
    !remote &&
    !alternateScreen &&
    promptLine !== suppressedPrompt
  )
}

function paletteStyle(palette: TerminalColors | undefined): CSSProperties | undefined {
  if (!palette) return undefined
  return {
    '--syn-fg': palette.foreground,
    '--syn-bg': palette.background,
    '--syn-selection': palette.selectionBackground,
    '--syn-command': palette.green,
    '--syn-unknown': palette.red,
    '--syn-flag': palette.cyan,
    '--syn-string': palette.yellow,
    '--syn-variable': palette.magenta,
    '--syn-operator': palette.blue,
    '--syn-comment': palette.brightBlack,
  } as CSSProperties
}

function useInputEditor({
  paneId,
  cwd,
  fontFamily,
  fontSize,
  alternateScreen,
  paneShown,
  suppressedPrompt,
  ownsFocus,
  termRef,
  hostRef,
  onSubmit,
  onHandOff,
  onShellKeys,
  onNeedRows,
}: InputEditorProps) {
  const visible = useInputEditorVisible(paneId, alternateScreen, suppressedPrompt)
  const vimEnabled = useSettingsStore((s) => s.behavior.inputEditorVim)
  const historySuggestionsOn = useSettingsStore((s) => s.behavior.historySuggestions)
  const prompt = useSettingsStore((s) => s.terminal.prompt)
  const ostiaPrompt = prompt.style === 'ostia'
  const catalog = useChipCatalog()
  const { chips } = usePromptChips(paneId, cwd, prompt.chips, visible && ostiaPrompt)
  const geo = usePromptGeometry(
    termRef,
    hostRef,
    visible,
    paneShown,
    ostiaPrompt ? 'ostia' : 'shell',
    prompt.sameLine,
  )
  const promptLine = useBlocksStore((s) => s.drafts[paneId]?.promptLine)
  const byPane = useBlocksStore((s) => s.byPane)
  const [composing, setComposing] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  const wasVisible = useRef(false)
  const vimModeRef = useRef<VimMode>('insert')
  const ownsFocusRef = useRef(ownsFocus)
  ownsFocusRef.current = ownsFocus
  const onHandOffRef = useRef(onHandOff)
  onHandOffRef.current = onHandOff
  const onNeedRowsRef = useRef(onNeedRows)
  onNeedRowsRef.current = onNeedRows

  const draft = useInputDraft({ paneId, visible, vimEnabled, vimModeRef })
  const { areaRef, text } = draft
  const vim = useInputVim({ vimEnabled, vimModeRef, setMenu: draft.setMenu })
  const { setVimModeState, setVimPending, undo } = vim
  const normal = vimEnabled && vim.vimMode === 'normal'

  useEffect(() => {
    const area = areaRef.current
    if (visible && !wasVisible.current) {
      vimModeRef.current = 'insert'
      setVimModeState('insert')
      setVimPending('')
      undo.current = []
      if (area && ownsFocusRef.current()) area.focus()
    }
    if (!visible && wasVisible.current && hadFocus.current) {
      hadFocus.current = false
      const active = document.activeElement
      if (!active || active === document.body || active === area) termRef.current?.focus()
    }
    wasVisible.current = visible
  }, [visible, termRef, areaRef, setVimModeState, setVimPending, undo])

  const history = useInputHistory({
    paneId,
    visible,
    promptLine,
    byPane,
    historySuggestionsOn,
    draft,
  })
  const completion = useInputCompletion({
    paneId,
    cwd,
    draft,
    menuRef,
    history,
    historySuggestionsOn,
  })
  const suggestions = useInputSuggestions({
    paneId,
    cwd,
    visible,
    draft,
    composing,
    normal,
    menuShown: completion.menuShown,
    historySuggestionsOn,
    history,
    byPane,
  })

  const onKeyDown = useInputEditorKeys({
    draft,
    vim,
    vimModeRef,
    vimEnabled,
    normal,
    completion,
    suggestions,
    history,
    composing,
    termRef,
    onSubmit,
    onHandOffRef,
    onShellKeys,
  })
  const layout = useInputLayout({
    geo,
    fontFamily,
    fontSize,
    visible,
    text,
    areaRef,
    onNeedRowsRef,
  })
  return {
    visible,
    vimEnabled,
    prompt,
    ostiaPrompt,
    catalog,
    chips,
    setComposing,
    composing,
    menuRef,
    hadFocus,
    draft,
    vim,
    normal,
    history,
    completion,
    suggestions,
    onKeyDown,
    layout,
  }
}

export function InputEditor(props: InputEditorProps): JSX.Element {
  const { paneId, cwd, fontFamily, palette, termRef } = props
  const d = useDict()
  const editor = useInputEditor(props)
  const { visible, vimEnabled, prompt, ostiaPrompt, catalog, chips, draft, vim, normal } = editor
  const { completion, suggestions, layout } = editor
  const { tip, text, selection } = draft
  const { cellHeight, line, chipsBox, popoverAbove } = layout

  const selectedText = text.slice(selection.start, selection.end)

  const chipRow = (sameLine: boolean): JSX.Element => (
    <PromptChipRow
      paneId={paneId}
      chips={chips}
      catalog={catalog}
      cwd={cwd}
      separator={prompt.separator}
      showSeparator={sameLine}
    />
  )

  const tipText = suggestions.suggestion
    ? null
    : tip === 'noPaths'
      ? d.inputEditor.noCompletions
      : tip === 'noCommands'
        ? d.inputEditor.noCommands
        : null

  return (
    <div
      className="input-editor"
      hidden={!visible}
      style={
        {
          ...paletteStyle(palette),
          '--cell-h': `${cellHeight}px`,
        } as CSSProperties
      }
    >
      {ostiaPrompt && !prompt.sameLine ? (
        <div
          className="input-editor-chips"
          data-placed={chipsBox ? 'true' : undefined}
          style={
            chipsBox
              ? {
                  left: chipsBox.left,
                  top: chipsBox.top,
                  width: chipsBox.width,
                  height: chipsBox.height,
                }
              : undefined
          }
        >
          {chipRow(false)}
        </div>
      ) : null}
      <div
        className="input-editor-line"
        data-placed={line ? 'true' : undefined}
        style={
          line
            ? { left: line.left, top: line.top, width: line.width, minHeight: line.height }
            : undefined
        }
      >
        <InputEditorMenu
          menuRef={editor.menuRef}
          popoverAbove={popoverAbove}
          fontFamily={fontFamily}
          menuShown={completion.menuShown}
          naturalOpen={suggestions.naturalOpen}
          tipText={tipText}
          setMenu={draft.setMenu}
          setNatural={suggestions.setNatural}
          pick={completion.pick}
          pickNatural={suggestions.pickNatural}
        />
        {ostiaPrompt && prompt.sameLine ? chipRow(true) : null}
        <InputEditorGhostMenu
          ghostFeature={suggestions.ghostFeature}
          selectedText={selectedText}
          typeAtCaret={draft.typeAtCaret}
          field={
            <div
              className="input-editor-field"
              data-composing={editor.composing || undefined}
              data-vim={normal ? 'normal' : undefined}
            >
              <InputEditorField
                draft={draft}
                layout={layout}
                setComposing={editor.setComposing}
                normal={normal}
                commandSet={editor.history.commandSet}
                ghost={suggestions.ghost}
                followMenu={completion.followMenu}
                onKeyDown={editor.onKeyDown}
                termRef={termRef}
                hadFocus={editor.hadFocus}
              />
            </div>
          }
        />
        {vimEnabled ? (
          <Badge variant="outline" className="input-editor-vim" aria-label={d.inputEditor.vimMode}>
            {vim.vimMode === 'normal' ? d.inputEditor.vimNormal : d.inputEditor.vimInsert}
            {vim.vimPending ? ` ${vim.vimPending}` : ''}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}
