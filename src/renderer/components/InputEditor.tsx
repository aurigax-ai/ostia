import { FolderSimpleIcon } from '@phosphor-icons/react'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { fmt, useDict } from '../i18n/useDict'
import { matchChord, useChordLabel } from '../lib/chords'
import {
  type CompletionItem,
  applyCompletionItem,
  caretOnFirstLine,
  completeCommand,
  completePath,
  completionToken,
  historySuggestion,
  inputHistory,
  isCommandWord,
  recentCommands,
  suggestionWord,
} from '../lib/inputEditor'
import { type ShellToken, tokenizeShell } from '../lib/shellTokens'
import { registerInputEditor } from '../lib/terminalHandles'
import { usePromptChips } from '../lib/usePromptChips'
import {
  type VimBuffer,
  type VimMode,
  applyVimCommand,
  canMoveVertically,
  clampNormal,
  enterNormal,
  parseVimKeys,
} from '../lib/vimMode'
import { isMac } from '../platform'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useChipCatalog } from '../stores/paneChipsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { PromptChipRow } from './PromptChips'
import type { TerminalPalette } from './terminalTheme'
import { Badge } from './ui/badge'
import { Command, CommandItem, CommandList } from './ui/command'
import { Textarea } from './ui/textarea'

const UNDO_LIMIT = 100

export interface InputEditorProps {
  paneId: string
  workspaceId: string
  cwd?: string
  fontFamily: string
  fontSize: number
  palette?: TerminalPalette
  alternateScreen: boolean
  suppressedPrompt: LineAnchor | null
  ownsFocus: () => boolean
  onSubmit: (text: string) => boolean
  onEscape: () => void
}

type Tip = 'hint' | 'noPaths' | 'noCommands'

interface Menu {
  items: CompletionItem[]
  index: number
}

interface Selection {
  start: number
  end: number
}

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

function paletteStyle(palette: TerminalPalette | undefined): CSSProperties | undefined {
  if (!palette) return undefined
  return {
    background: palette.background,
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

function itemLabel(item: CompletionItem): string {
  return item.dir ? `${item.name}/` : item.name
}

function unescapeWord(word: string): string {
  return word.replace(/\\(.)/g, '$1')
}

function tokenClass(token: ShellToken, commands: ReadonlySet<string> | null): string {
  if (token.kind !== 'command') return `syn-${token.kind}`
  const name = unescapeWord(token.text)
  const known = !commands || name.includes('/') || commands.has(name)
  return known ? 'syn-command' : 'syn-unknown'
}

function renderDraft(
  text: string,
  commands: ReadonlySet<string> | null,
  cursor: number | null,
): ReactNode[] {
  const block = (char: string): ReactNode => (
    <span key="cursor" className="input-editor-block-cursor">
      {char}
    </span>
  )
  const nodes: ReactNode[] = []
  for (const token of tokenizeShell(text)) {
    const className = tokenClass(token, commands)
    const data = {
      className,
      'data-token': token.kind,
      'data-known': token.kind === 'command' ? String(className === 'syn-command') : undefined,
    }
    const at = cursor === null ? -1 : cursor - token.start
    if (at < 0 || at >= token.text.length) {
      nodes.push(
        <span key={token.start} {...data}>
          {token.text}
        </span>,
      )
    } else if (token.text[at] === '\n') {
      nodes.push(block(' '))
      nodes.push(
        <span key={token.start} {...data}>
          {token.text}
        </span>,
      )
    } else {
      nodes.push(
        <span key={token.start} {...data}>
          {token.text.slice(0, at)}
          {block(token.text[at])}
          {token.text.slice(at + 1)}
        </span>,
      )
    }
  }
  if (cursor !== null && cursor >= text.length) nodes.push(block(' '))
  return nodes
}

export function InputEditor({
  paneId,
  workspaceId,
  cwd,
  fontFamily,
  fontSize,
  palette,
  alternateScreen,
  suppressedPrompt,
  ownsFocus,
  onSubmit,
  onEscape,
}: InputEditorProps): JSX.Element {
  const d = useDict()
  const historyKeys = useChordLabel('history.search', isMac)
  const visible = useInputEditorVisible(paneId, alternateScreen, suppressedPrompt)
  const vimEnabled = useSettingsStore((s) => s.behavior.inputEditorVim)
  const prompt = useSettingsStore((s) => s.terminal.prompt)
  const pinePrompt = prompt.style === 'pine'
  const catalog = useChipCatalog()
  const { chips } = usePromptChips(paneId, cwd, prompt.chips, visible && pinePrompt)
  const promptLine = useBlocksStore((s) => s.drafts[paneId]?.promptLine)
  const byPane = useBlocksStore((s) => s.byPane)
  const [text, setText] = useState('')
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 })
  const [tip, setTip] = useState<Tip>('hint')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [commands, setCommands] = useState<string[] | null>(null)
  const [vimMode, setVimModeState] = useState<VimMode>('insert')
  const [vimPending, setVimPending] = useState('')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  const wasVisible = useRef(false)
  const walk = useRef<{ index: number; saved: string; entries: string[] } | null>(null)
  const completing = useRef(0)
  const undo = useRef<VimBuffer[]>([])
  const pendingCaret = useRef<number | null>(null)
  const vimModeRef = useRef<VimMode>('insert')
  const ownsFocusRef = useRef(ownsFocus)
  ownsFocusRef.current = ownsFocus
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape

  const normal = vimEnabled && vimMode === 'normal'
  const history = useMemo(() => inputHistory(byPane, paneId), [byPane, paneId])
  const commandSet = useMemo(() => (commands ? new Set(commands) : null), [commands])

  const setVimMode = (mode: VimMode): void => {
    vimModeRef.current = mode
    setVimModeState(mode)
    setVimPending('')
  }

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
      if (!active || active === document.body || active === area) onEscapeRef.current()
    }
    wasVisible.current = visible
  }, [visible])

  useEffect(() => {
    if (!visible || !promptLine) return
    let live = true
    window.pine.pty
      .commands(paneId)
      .then((names) => {
        if (live) setCommands(names.length > 0 ? names : null)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [paneId, visible, promptLine])

  useEffect(() => {
    if (vimEnabled) return
    vimModeRef.current = 'insert'
    setVimModeState('insert')
    setVimPending('')
  }, [vimEnabled])

  const replaceText = (next: string, caret = next.length): void => {
    const at = vimModeRef.current === 'normal' && vimEnabled ? clampNormal(next, caret) : caret
    setText(next)
    setSelection({ start: at, end: at })
    pendingCaret.current = at
  }

  useLayoutEffect(() => {
    const caret = pendingCaret.current
    const area = areaRef.current
    if (caret === null || !area) return
    pendingCaret.current = null
    area.setSelectionRange(caret, caret)
  })

  const resetDraftState = (): void => {
    walk.current = null
    setTip('hint')
    setMenu(null)
    setDismissed(null)
  }

  useEffect(() => {
    if (!visible) return
    return registerInputEditor(paneId, {
      insert: (command) => {
        setText(command)
        setSelection({ start: command.length, end: command.length })
        pendingCaret.current = command.length
        walk.current = null
        setTip('hint')
        setMenu(null)
        areaRef.current?.focus()
      },
    })
  }, [paneId, visible])

  const menuOpen = menu !== null
  useEffect(() => {
    const root = menuRef.current
    const area = areaRef.current
    if (!menuOpen || !root || !area) return
    const sync = (): void => {
      const list = root.querySelector('[role="listbox"]')
      if (list) area.setAttribute('aria-controls', list.id)
      const active = root.querySelector('[cmdk-item][aria-selected="true"]')
      if (!(active instanceof HTMLElement)) return
      area.setAttribute('aria-activedescendant', active.id)
      active.scrollIntoView?.({ block: 'nearest' })
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
    return () => {
      observer.disconnect()
      area.removeAttribute('aria-activedescendant')
      area.removeAttribute('aria-controls')
    }
  }, [menuOpen])

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

  const pick = (item: CompletionItem): void => {
    const area = areaRef.current
    const caret = area ? area.selectionStart : text.length
    const next = applyCompletionItem(text, caret, item)
    setMenu(null)
    setTip('hint')
    replaceText(next.text, next.caret)
  }

  const complete = async (area: HTMLTextAreaElement): Promise<void> => {
    const caret = area.selectionStart
    const ticket = ++completing.current
    const commandWord = isCommandWord(text, caret)
    const result = commandWord
      ? completeCommand(commands ?? [], completionToken(text, caret).word, recentCommands(history))
      : await completePath(text, caret, cwd ?? '~', (p) => window.pine.fs.list(p))
    if (ticket !== completing.current) return
    if (result.insert) {
      replaceText(
        text.slice(0, caret) + result.insert + text.slice(caret),
        caret + result.insert.length,
      )
    }
    if (result.candidates.length > 0) {
      setMenu({ items: result.candidates, index: 0 })
      setTip('hint')
    } else {
      setMenu(null)
      setTip(result.insert ? 'hint' : commandWord ? 'noCommands' : 'noPaths')
    }
  }

  const suggestion =
    visible &&
    !composing &&
    !normal &&
    !menu &&
    !walk.current &&
    selection.start === selection.end &&
    selection.end === text.length &&
    dismissed !== text
      ? historySuggestion(text, history)
      : ''

  const acceptSuggestion = (part: string): void => {
    replaceText(text + part)
    setDismissed(null)
  }

  const submit = (): void => {
    if (!onSubmit(text)) return
    setText('')
    setSelection({ start: 0, end: 0 })
    resetDraftState()
    undo.current = []
    if (vimEnabled) setVimMode('insert')
  }

  const onMenuKey = (e: KeyboardEvent<HTMLTextAreaElement>, open: Menu): boolean => {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if (!plain) return false
    const count = open.items.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setMenu({ ...open, index: (open.index + step + count) % count })
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pick(open.items[open.index])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setMenu(null)
      return true
    }
    return false
  }

  const onNormalKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const area = e.currentTarget
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      if (vimPending) setVimPending('')
      else onEscape()
      return true
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      e.preventDefault()
      return true
    }
    if (e.key.length !== 1) return false
    e.preventDefault()
    const keys = vimPending + e.key
    const command = parseVimKeys(keys)
    if (command === 'pending') {
      setVimPending(keys)
      return true
    }
    setVimPending('')
    if (!command) return true
    const caret = area.selectionStart
    if (command.kind === 'undo') {
      let restored: VimBuffer | undefined
      for (let n = 0; n < command.count; n++) restored = undo.current.pop() ?? restored
      if (restored) replaceText(restored.text, restored.caret)
      return true
    }
    if (command.kind === 'move' && (command.motion === 'j' || command.motion === 'k')) {
      const down = command.motion === 'j'
      if (!canMoveVertically(text, caret, down)) {
        if (!down || walk.current) stepHistory(down ? 'newer' : 'older')
        return true
      }
    }
    if (command.kind !== 'move') {
      undo.current.push({ text, caret })
      if (undo.current.length > UNDO_LIMIT) undo.current.shift()
    }
    const result = applyVimCommand(command, { text, caret })
    if (result.mode !== vimModeRef.current) setVimMode(result.mode)
    if (result.text !== text) walk.current = null
    replaceText(result.text, result.caret)
    return true
  }

  const acceptWordChord = (e: KeyboardEvent<HTMLTextAreaElement>): boolean =>
    isMac
      ? e.altKey && !e.ctrlKey && !e.metaKey && e.code === 'KeyF'
      : e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && e.key === 'ArrowRight'

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.nativeEvent.isComposing || composing) return
    const area = e.currentTarget
    if (menu && onMenuKey(e, menu)) return
    if (menu && e.key !== 'Shift') setMenu(null)
    if (normal && onNormalKey(e)) return
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === 'Enter' && plain && !e.shiftKey) {
      e.preventDefault()
      submit()
      return
    }
    if (e.key === 'Escape' && plain && !e.shiftKey) {
      e.preventDefault()
      if (vimEnabled) {
        const next = enterNormal({ text, caret: area.selectionStart })
        setVimMode('normal')
        replaceText(next.text, next.caret)
      } else if (suggestion) setDismissed(text)
      else onEscape()
      return
    }
    if (suggestion && plain && !e.shiftKey && (e.key === 'ArrowRight' || e.key === 'End')) {
      e.preventDefault()
      acceptSuggestion(suggestion)
      return
    }
    if (suggestion && acceptWordChord(e)) {
      e.preventDefault()
      acceptSuggestion(suggestionWord(suggestion))
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
      setSelection({ start: 0, end: 0 })
      resetDraftState()
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

  const chipRow = (sameLine: boolean): JSX.Element => (
    <PromptChipRow
      paneId={paneId}
      workspaceId={workspaceId}
      chips={chips}
      catalog={catalog}
      cwd={cwd}
      separator={prompt.separator}
      showSeparator={sameLine}
    />
  )

  const hint = historyKeys
    ? fmt(d.inputEditor.hint, { history: historyKeys })
    : d.inputEditor.hintNoHistory

  return (
    <div className="input-editor" hidden={!visible} style={paletteStyle(palette)}>
      {menu ? (
        <div ref={menuRef} className="input-editor-menu">
          <Command
            shouldFilter={false}
            value={itemLabel(menu.items[menu.index])}
            onValueChange={(value) => {
              const index = menu.items.findIndex((item) => itemLabel(item) === value)
              if (index >= 0 && index !== menu.index) setMenu({ ...menu, index })
            }}
            onMouseDown={(e) => e.preventDefault()}
            className="h-auto rounded-md! border shadow-md"
            style={{ fontFamily }}
          >
            <CommandList label={d.inputEditor.completions}>
              {menu.items.map((item) => (
                <CommandItem
                  key={itemLabel(item)}
                  value={itemLabel(item)}
                  className="input-editor-menu-item"
                  onSelect={() => pick(item)}
                >
                  {itemLabel(item)}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </div>
      ) : null}
      <div className="input-editor-meta">
        {!pinePrompt ? (
          <span className="input-editor-cwd" aria-label={d.inputEditor.cwd}>
            <FolderSimpleIcon size={12} aria-hidden="true" />
            <span className="input-editor-cwd-path">{cwd ?? '~'}</span>
          </span>
        ) : prompt.sameLine ? null : (
          chipRow(false)
        )}
        {vimEnabled ? (
          <Badge variant="outline" className="input-editor-vim" aria-label={d.inputEditor.vimMode}>
            {vimMode === 'normal' ? d.inputEditor.vimNormal : d.inputEditor.vimInsert}
            {vimPending ? ` ${vimPending}` : ''}
          </Badge>
        ) : null}
        <span className="input-editor-tip" aria-live="polite">
          {tip === 'noPaths' ? d.inputEditor.noCompletions : null}
          {tip === 'noCommands' ? d.inputEditor.noCommands : null}
          {tip === 'hint' ? hint : null}
        </span>
      </div>
      <div className="input-editor-line">
        {pinePrompt && prompt.sameLine ? chipRow(true) : null}
        <div
          className="input-editor-field"
          data-composing={composing || undefined}
          data-vim={normal ? 'normal' : undefined}
        >
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
            className="input-editor-area min-h-0 resize-none rounded-md px-2 py-1.5"
            style={{ fontFamily, fontSize }}
            onChange={(e) => {
              setText(e.target.value)
              setSelection({ start: e.target.selectionStart, end: e.target.selectionEnd })
              walk.current = null
              if (tip !== 'hint') setTip('hint')
              if (menu) setMenu(null)
            }}
            onSelect={(e) => {
              const area = e.currentTarget
              setSelection({ start: area.selectionStart, end: area.selectionEnd })
            }}
            onScroll={(e) => {
              if (overlayRef.current) overlayRef.current.scrollTop = e.currentTarget.scrollTop
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
          <div
            ref={overlayRef}
            className="input-editor-highlight rounded-md px-2 py-1.5"
            style={{ fontFamily, fontSize }}
            aria-hidden="true"
            data-testid="input-editor-highlight"
          >
            {renderDraft(text, commandSet, normal ? clampNormal(text, selection.start) : null)}
            {suggestion ? <span className="input-editor-ghost">{suggestion}</span> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
