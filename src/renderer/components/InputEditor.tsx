import { FolderSimpleIcon } from '@phosphor-icons/react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { FsEntry } from '../../shared/types'
import { fmt, useDict } from '../i18n/useDict'
import { matchChord, useChordLabel } from '../lib/chords'
import { caretOnFirstLine, completePath, inputHistory } from '../lib/inputEditor'
import { registerInputEditor } from '../lib/terminalHandles'
import { isMac } from '../platform'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useSettingsStore } from '../stores/settingsStore'
import { Textarea } from './ui/textarea'

const MAX_CANDIDATES = 8

export interface InputEditorProps {
  paneId: string
  cwd?: string
  fontFamily: string
  fontSize: number
  background?: string
  alternateScreen: boolean
  suppressedPrompt: LineAnchor | null
  ownsFocus: () => boolean
  onSubmit: (text: string) => boolean
  onEscape: () => void
}

type Tip = { kind: 'hint' } | { kind: 'none' } | { kind: 'candidates'; entries: FsEntry[] }

export function useInputEditorVisible(
  paneId: string,
  alternateScreen: boolean,
  suppressedPrompt: LineAnchor | null,
): boolean {
  const mode = useSettingsStore((s) => s.behavior.inputMode)
  const promptLine = useBlocksStore((s) => s.drafts[paneId]?.promptLine)
  const running = useBlocksStore((s) => Boolean(s.running[paneId]))
  return (
    mode === 'editor' &&
    Boolean(promptLine) &&
    !running &&
    !alternateScreen &&
    promptLine !== suppressedPrompt
  )
}

export function InputEditor({
  paneId,
  cwd,
  fontFamily,
  fontSize,
  background,
  alternateScreen,
  suppressedPrompt,
  ownsFocus,
  onSubmit,
  onEscape,
}: InputEditorProps): JSX.Element {
  const d = useDict()
  const historyKeys = useChordLabel('history.search', isMac)
  const visible = useInputEditorVisible(paneId, alternateScreen, suppressedPrompt)
  const [text, setText] = useState('')
  const [tip, setTip] = useState<Tip>({ kind: 'hint' })
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const hadFocus = useRef(false)
  const wasVisible = useRef(false)
  const walk = useRef<{ index: number; saved: string; entries: string[] } | null>(null)
  const completing = useRef(0)
  const ownsFocusRef = useRef(ownsFocus)
  ownsFocusRef.current = ownsFocus
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  useEffect(() => {
    const area = areaRef.current
    if (visible && !wasVisible.current && area && ownsFocusRef.current()) area.focus()
    if (!visible && wasVisible.current && hadFocus.current) {
      hadFocus.current = false
      const active = document.activeElement
      if (!active || active === document.body || active === area) onEscapeRef.current()
    }
    wasVisible.current = visible
  }, [visible])

  useEffect(() => {
    if (!visible) return
    return registerInputEditor(paneId, {
      insert: (command) => {
        setText(command)
        walk.current = null
        setTip({ kind: 'hint' })
        const area = areaRef.current
        if (!area) return
        area.focus()
        requestAnimationFrame(() => area.setSelectionRange(command.length, command.length))
      },
    })
  }, [paneId, visible])

  const replaceText = (next: string, caret = next.length): void => {
    setText(next)
    const area = areaRef.current
    if (area) requestAnimationFrame(() => area.setSelectionRange(caret, caret))
  }

  const stepHistory = (dir: 'older' | 'newer'): boolean => {
    const state = walk.current ?? {
      index: -1,
      saved: text,
      entries: inputHistory(useBlocksStore.getState().byPane, paneId),
    }
    const index = dir === 'older' ? state.index + 1 : state.index - 1
    if (index >= state.entries.length || index < -1) return false
    walk.current = index === -1 ? null : { ...state, index }
    replaceText(index === -1 ? state.saved : state.entries[index])
    return true
  }

  const complete = async (area: HTMLTextAreaElement): Promise<void> => {
    const caret = area.selectionStart
    const ticket = ++completing.current
    const result = await completePath(text, caret, cwd ?? '~', (p) => window.pine.fs.list(p))
    if (ticket !== completing.current) return
    if (result.insert) {
      replaceText(
        text.slice(0, caret) + result.insert + text.slice(caret),
        caret + result.insert.length,
      )
    }
    if (result.candidates.length > 0) setTip({ kind: 'candidates', entries: result.candidates })
    else if (!result.insert) setTip({ kind: 'none' })
    else setTip({ kind: 'hint' })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    const area = e.currentTarget
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'Enter' && plain && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (onSubmit(text)) {
        setText('')
        walk.current = null
        setTip({ kind: 'hint' })
      }
      return
    }
    if (e.key === 'Escape' && plain && !e.shiftKey) {
      e.preventDefault()
      onEscape()
      return
    }
    if (e.key === 'Tab' && plain && !e.shiftKey) {
      e.preventDefault()
      void complete(area)
      return
    }
    if (e.key.toLowerCase() === 'c' && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      setText('')
      walk.current = null
      setTip({ kind: 'hint' })
      return
    }
    if (!isMac && matchChord(e, false) === 'copy') {
      e.preventDefault()
      const selected = text.slice(area.selectionStart, area.selectionEnd)
      if (selected) void navigator.clipboard.writeText(selected)
      return
    }
    const collapsed = area.selectionStart === area.selectionEnd
    if (e.key === 'ArrowUp' && plain && !e.shiftKey && collapsed) {
      const walking = walk.current !== null
      if ((walking || caretOnFirstLine(text, area.selectionStart)) && stepHistory('older')) {
        e.preventDefault()
      }
      return
    }
    if (e.key === 'ArrowDown' && plain && !e.shiftKey && collapsed && walk.current) {
      if (stepHistory('newer')) e.preventDefault()
    }
  }

  const hint = historyKeys
    ? fmt(d.inputEditor.hint, { history: historyKeys })
    : d.inputEditor.hintNoHistory

  return (
    <div className="input-editor" hidden={!visible} style={{ background }}>
      <div className="input-editor-meta">
        <span className="input-editor-cwd" aria-label={d.inputEditor.cwd}>
          <FolderSimpleIcon size={12} aria-hidden="true" />
          <span className="input-editor-cwd-path">{cwd ?? '~'}</span>
        </span>
        <span className="input-editor-tip" aria-live="polite">
          {tip.kind === 'none' ? d.inputEditor.noCompletions : null}
          {tip.kind === 'candidates' ? <Candidates entries={tip.entries} /> : null}
          {tip.kind === 'hint' ? hint : null}
        </span>
      </div>
      <Textarea
        ref={areaRef}
        rows={1}
        value={text}
        aria-label={d.inputEditor.label}
        placeholder={d.inputEditor.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        className="input-editor-area min-h-0 resize-none rounded-md px-2 py-1.5"
        style={{ fontFamily, fontSize }}
        onChange={(e) => {
          setText(e.target.value)
          walk.current = null
          if (tip.kind !== 'hint') setTip({ kind: 'hint' })
        }}
        onKeyDown={onKeyDown}
        onFocus={() => {
          hadFocus.current = true
        }}
        onBlur={(e) => {
          if (e.relatedTarget) hadFocus.current = false
        }}
      />
    </div>
  )
}

function Candidates({ entries }: { entries: FsEntry[] }): JSX.Element {
  const d = useDict()
  const shown = entries.slice(0, MAX_CANDIDATES)
  const more = entries.length - shown.length
  return (
    <>
      {shown.map((e) => (
        <span key={e.name} className="input-editor-candidate">
          {e.dir ? `${e.name}/` : e.name}
        </span>
      ))}
      {more > 0 ? (
        <span className="input-editor-candidate">
          {fmt(d.inputEditor.moreCompletions, { n: more })}
        </span>
      ) : null}
    </>
  )
}
