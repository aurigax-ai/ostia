import { type JSX, type KeyboardEvent, type MutableRefObject, type RefObject, useRef } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { useDict } from '@/lib/app/useDict'
import { planDraftPaste } from '@/lib/keyboard/pasteGate'
import type { Ghost } from '@/lib/prompt/terminalGhost'
import { clampNormal } from '@/lib/prompt/vimMode'
import type { OstiaTerminal as Xterm } from '@/lib/terminal/ostiaTerminal'
import { InputEditorHighlight } from './InputEditorHighlight'
import type { InputDraft } from './useInputDraft'
import type { InputLayout } from './useInputLayout'

export function InputEditorField({
  draft: { areaRef, text, setText, setSelection, selection, walk, tip, setTip, typeAtCaret },
  layout: { cellStyle, cellHeight, maxLines, line },
  setComposing,
  normal,
  commandSet,
  ghost,
  followMenu,
  typed,
  onKeyDown,
  termRef,
  hadFocus,
}: {
  draft: InputDraft
  layout: InputLayout
  setComposing: (composing: boolean) => void
  normal: boolean
  commandSet: ReadonlySet<string> | null
  ghost: Ghost
  followMenu: (draft: string, start: number, end: number) => void
  typed: (draft: string, start: number, end: number) => void
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void
  termRef: RefObject<Xterm | null>
  hadFocus: MutableRefObject<boolean>
}): JSX.Element {
  const d = useDict()
  const overlayRef = useRef<HTMLDivElement>(null)
  return (
    <>
      <Textarea
        ref={areaRef}
        rows={1}
        value={text}
        aria-label={d.inputEditor.label}
        aria-autocomplete="list"
        placeholder={d.inputEditor.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className="input-editor-area min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none outline-none dark:bg-transparent"
        style={{ ...cellStyle, maxHeight: cellHeight ? maxLines * cellHeight : undefined }}
        onChange={(e) => {
          setText(e.target.value)
          setSelection({ start: e.target.selectionStart, end: e.target.selectionEnd })
          walk.current = null
          if (tip !== 'none') setTip('none')
          typed(e.target.value, e.target.selectionStart, e.target.selectionEnd)
          if (!line) termRef.current?.scrollToBottom()
        }}
        onSelect={(e) => {
          const area = e.currentTarget
          setSelection({ start: area.selectionStart, end: area.selectionEnd })
          followMenu(area.value, area.selectionStart, area.selectionEnd)
        }}
        onScroll={(e) => {
          if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop
        }}
        onPaste={(e) => {
          e.preventDefault()
          const draft = planDraftPaste(e.clipboardData.getData('text/plain'))
          if (draft) typeAtCaret(draft)
        }}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          hadFocus.current = true
        }}
        onBlur={(e) => {
          if (e.relatedTarget) hadFocus.current = false
        }}
      />
      <InputEditorHighlight
        overlayRef={overlayRef}
        style={cellStyle}
        text={text}
        commands={commandSet}
        cursor={normal ? clampNormal(text, selection.start) : null}
        ghost={ghost}
      />
    </>
  )
}
