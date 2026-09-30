import type { CommandSuggestion } from '@shared/assist'
import type { SpecCommand } from '@shared/completionSpec'
import type { Terminal as Xterm } from '@xterm/xterm'
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useDict } from '../i18n/useDict'
import { latestRequest, naturalCommandQuery } from '../lib/assistComposer'
import { matchChord } from '../lib/chords'
import {
  type CompletionItem,
  applyCompletionItem,
  caretOnFirstLine,
  completeArgument,
  completeCommand,
  completionToken,
  historyMatches,
  historySuggestion,
  inputHistory,
  isCommandWord,
  recentCommands,
  suggestionWord,
} from '../lib/inputEditor'
import { applyLineEdit, lineEditOp, shellKeyBytes } from '../lib/lineEditing'
import { usePaneChipCatalog } from '../lib/paneChips'
import { cellBox, rowsToMake } from '../lib/promptOverlay'
import { type ShellToken, tokenizeShell } from '../lib/shellTokens'
import { registerInputEditor } from '../lib/terminalHandles'
import { usePromptChips } from '../lib/usePromptChips'
import { usePromptGeometry } from '../lib/usePromptGeometry'
import {
  type VimBuffer,
  type VimMode,
  applyVimCommand,
  canMoveVertically,
  clampNormal,
  enterNormal,
  parseVimKeys,
} from '../lib/vimMode'
import { isMac, platform } from '../platform'
import { assistRequest, useAssistProvider } from '../stores/assistStore'
import { type LineAnchor, useBlocksStore } from '../stores/blocksStore'
import { useSettingsStore } from '../stores/settingsStore'
import { PromptChipRow } from './PromptChips'
import type { TerminalPalette } from './terminalTheme'
import { Badge } from './ui/badge'
import { Command, CommandItem, CommandList } from './ui/command'
import { Textarea } from './ui/textarea'

const UNDO_LIMIT = 100
const MAX_LINES = 8
export const NATURAL_COMMAND_DEBOUNCE_MS = 600

export interface InputEditorProps {
  paneId: string
  cwd?: string
  fontFamily: string
  fontSize: number
  palette?: TerminalPalette
  alternateScreen: boolean
  suppressedPrompt: LineAnchor | null
  termRef: RefObject<Xterm | null>
  hostRef: RefObject<HTMLElement | null>
  ownsFocus: () => boolean
  onSubmit: (text: string) => boolean
  onHandOff: (draft: string, keys: string) => void
  onShellKeys: (keys: string) => void
  onNeedRows: (rows: number) => void
}

type Tip = 'none' | 'noPaths' | 'noCommands'

interface Menu {
  items: CompletionItem[]
  index: number
}

interface NaturalCommands {
  for: string
  items: CommandSuggestion[]
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

let measureCanvas: HTMLCanvasElement | null = null

function charWidth(fontFamily: string, fontSize: number): number | null {
  measureCanvas ??= document.createElement('canvas')
  let ctx: CanvasRenderingContext2D | null = null
  try {
    ctx = measureCanvas.getContext('2d')
  } catch {
    return null
  }
  if (!ctx) return null
  ctx.font = `${fontSize}px ${fontFamily}`
  const sample = 'W'.repeat(32)
  const width = ctx.measureText(sample).width
  return width > 0 ? width / sample.length : null
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
  cwd,
  fontFamily,
  fontSize,
  palette,
  alternateScreen,
  suppressedPrompt,
  ownsFocus,
  termRef,
  hostRef,
  onSubmit,
  onHandOff,
  onShellKeys,
  onNeedRows,
}: InputEditorProps): JSX.Element {
  const d = useDict()
  const visible = useInputEditorVisible(paneId, alternateScreen, suppressedPrompt)
  const vimEnabled = useSettingsStore((s) => s.behavior.inputEditorVim)
  const prompt = useSettingsStore((s) => s.terminal.prompt)
  const pinePrompt = prompt.style === 'pine'
  const catalog = usePaneChipCatalog()
  const { chips } = usePromptChips(paneId, cwd, prompt.chips, visible && pinePrompt)
  const geo = usePromptGeometry(
    termRef,
    hostRef,
    visible,
    pinePrompt ? 'pine' : 'shell',
    prompt.sameLine,
  )
  const promptLine = useBlocksStore((s) => s.drafts[paneId]?.promptLine)
  const byPane = useBlocksStore((s) => s.byPane)
  const [text, setText] = useState('')
  const [selection, setSelection] = useState<Selection>({ start: 0, end: 0 })
  const [tip, setTip] = useState<Tip>('none')
  const [menu, setMenu] = useState<Menu | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [composing, setComposing] = useState(false)
  const [commands, setCommands] = useState<string[] | null>(null)
  const [vimMode, setVimModeState] = useState<VimMode>('insert')
  const [vimPending, setVimPending] = useState('')
  const [natural, setNatural] = useState<NaturalCommands | null>(null)
  const [naturalDismissed, setNaturalDismissed] = useState<string | null>(null)
  const naturalRequest = useRef(latestRequest())
  const commandAssist = useAssistProvider('command')
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const hadFocus = useRef(false)
  const wasVisible = useRef(false)
  const walk = useRef<{ index: number; saved: string; entries: string[] } | null>(null)
  const completing = useRef(0)
  const specs = useRef(new Map<string, Promise<SpecCommand | null>>())
  const undo = useRef<VimBuffer[]>([])
  const pendingCaret = useRef<number | null>(null)
  const vimModeRef = useRef<VimMode>('insert')
  const ownsFocusRef = useRef(ownsFocus)
  ownsFocusRef.current = ownsFocus
  const textRef = useRef(text)
  textRef.current = text
  const killRing = useRef('')
  const onHandOffRef = useRef(onHandOff)
  onHandOffRef.current = onHandOff
  const onNeedRowsRef = useRef(onNeedRows)
  onNeedRowsRef.current = onNeedRows

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
      if (!active || active === document.body || active === area) termRef.current?.focus()
    }
    wasVisible.current = visible
  }, [visible, termRef])

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
    setTip('none')
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
        setTip('none')
        setMenu(null)
        areaRef.current?.focus()
      },
      type: (chunk) => {
        const area = areaRef.current
        const current = textRef.current
        const start = area ? area.selectionStart : current.length
        const end = area ? area.selectionEnd : current.length
        const next = current.slice(0, start) + chunk + current.slice(end)
        setText(next)
        setSelection({ start: start + chunk.length, end: start + chunk.length })
        pendingCaret.current = start + chunk.length
        walk.current = null
        setMenu(null)
        area?.focus()
      },
      focus: () => areaRef.current?.focus(),
    })
  }, [paneId, visible])

  useEffect(() => {
    const request = naturalRequest.current
    const query = visible && commandAssist ? naturalCommandQuery(text) : null
    if (!query) {
      request.cancel()
      return
    }
    request.run(async (signal) => {
      const res = await assistRequest(
        'command',
        { query, ...(cwd ? { cwd } : {}), platform },
        { signal },
      )
      if (signal.aborted || !res.ok || res.result.suggestions.length === 0) return
      setNatural({ for: text, items: res.result.suggestions, index: 0 })
    }, NATURAL_COMMAND_DEBOUNCE_MS)
  }, [text, visible, commandAssist, cwd])

  useEffect(() => {
    const request = naturalRequest.current
    return () => request.cancel()
  }, [])

  const naturalOpen =
    visible && !menu && natural !== null && natural.for === text && naturalDismissed !== text
      ? natural
      : null

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
      entries: historyMatches(inputHistory(useBlocksStore.getState().byPane, paneId), text),
    }
    const index = dir === 'older' ? state.index + 1 : state.index - 1
    if (index >= state.entries.length || index < -1) return false
    walk.current = index === -1 ? null : { ...state, index }
    replaceText(index === -1 ? state.saved : state.entries[index])
    return true
  }

  const loadSpec = (command: string): Promise<SpecCommand | null> => {
    const known = specs.current.get(command)
    if (known) return known
    const loading = window.pine.completions.spec(command).catch(() => null)
    specs.current.set(command, loading)
    return loading
  }

  const pick = (item: CompletionItem): void => {
    const area = areaRef.current
    const caret = area ? area.selectionStart : text.length
    const next = applyCompletionItem(text, caret, item)
    setMenu(null)
    setTip('none')
    replaceText(next.text, next.caret)
  }

  const complete = async (area: HTMLTextAreaElement): Promise<void> => {
    const caret = area.selectionStart
    const ticket = ++completing.current
    const commandWord = isCommandWord(text, caret)
    const result = commandWord
      ? completeCommand(commands ?? [], completionToken(text, caret).word, recentCommands(history))
      : await completeArgument(text, caret, cwd ?? '~', {
          spec: loadSpec,
          list: (p) => window.pine.fs.list(p),
        })
    if (ticket !== completing.current) return
    if (result.insert) {
      replaceText(
        text.slice(0, caret) + result.insert + text.slice(caret),
        caret + result.insert.length,
      )
    }
    if (result.candidates.length > 0) {
      setMenu({ items: result.candidates, index: 0 })
      setTip('none')
    } else {
      setMenu(null)
      setTip(result.insert ? 'none' : commandWord ? 'noCommands' : 'noPaths')
    }
  }

  const suggestion =
    visible &&
    !composing &&
    !normal &&
    !menu &&
    !naturalOpen &&
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

  const onNaturalKey = (e: KeyboardEvent<HTMLTextAreaElement>, open: NaturalCommands): boolean => {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if (!plain) return false
    const count = open.items.length
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setNatural({ ...open, index: (open.index + step + count) % count })
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      pickNatural(open.items[open.index])
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      setNaturalDismissed(text)
      return true
    }
    return false
  }

  const pickNatural = (item: CommandSuggestion): void => {
    setNatural(null)
    replaceText(item.command)
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
      else handOff('')
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

  const handOff = (keys: string): void => {
    const draft = text
    setText('')
    setSelection({ start: 0, end: 0 })
    resetDraftState()
    undo.current = []
    onHandOffRef.current(draft, keys)
  }

  const onLineEditKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    const area = e.currentTarget
    const op = lineEditOp(e)
    if (!op || (isMac && e.altKey)) return false
    e.preventDefault()
    if (op === 'historyPrev' || op === 'historyNext') {
      stepHistory(op === 'historyPrev' ? 'older' : 'newer')
      return true
    }
    if (op === 'clearScreen') {
      onShellKeys('\x0c')
      return true
    }
    if (op === 'deleteChar' && text === '') {
      handOff('\x04')
      return true
    }
    const result = applyLineEdit(op, { text, caret: area.selectionStart }, killRing.current)
    if (result.killed) killRing.current = result.killed
    if (result.text !== text) {
      walk.current = null
      setMenu(null)
    }
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
    if (naturalOpen && onNaturalKey(e, naturalOpen)) return
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
      else handOff('')
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
      const selected =
        text.slice(area.selectionStart, area.selectionEnd) || termRef.current?.getSelection()
      if (selected) void navigator.clipboard.writeText(selected)
      return
    }
    if (onLineEditKey(e)) return
    const keys = isMac && e.altKey ? null : shellKeyBytes(e)
    if (keys) {
      e.preventDefault()
      handOff(keys)
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
      chips={chips}
      catalog={catalog}
      cwd={cwd}
      separator={prompt.separator}
      showSeparator={sameLine}
    />
  )

  const metrics = geo?.metrics
  const letterSpacing = useMemo(() => {
    if (!metrics) return 0
    const measured = charWidth(fontFamily, fontSize)
    return measured === null ? 0 : metrics.width - measured
  }, [fontFamily, fontSize, metrics])

  const cellHeight = metrics?.height ?? 0
  const rowsBelow = geo?.placement.rowsBelow ?? 0
  // biome-ignore lint/correctness/useExhaustiveDependencies: text changes the textarea height
  useLayoutEffect(() => {
    const area = areaRef.current
    if (!visible || !area || cellHeight <= 0) return
    const lines = Math.round(area.scrollHeight / cellHeight)
    const rows = rowsToMake(lines, rowsBelow, MAX_LINES)
    if (rows > 0) onNeedRowsRef.current(rows)
  }, [visible, text, cellHeight, rowsBelow])

  const line = geo
    ? cellBox(geo.metrics, geo.placement.row, geo.placement.col, geo.placement.endCol)
    : null
  const chipsBox =
    geo && geo.placement.chipsRow !== null
      ? cellBox(geo.metrics, geo.placement.chipsRow, 0, geo.cols)
      : null
  const popoverAbove = geo ? geo.placement.row >= geo.rows / 2 : true
  const maxLines = Math.min(MAX_LINES, rowsBelow + 1)
  const cellStyle = {
    fontFamily,
    fontSize,
    lineHeight: `${cellHeight}px`,
    letterSpacing: letterSpacing ? `${letterSpacing}px` : undefined,
  }
  const tipText =
    tip === 'noPaths'
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
      {pinePrompt && !prompt.sameLine ? (
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
        {menu || tipText || naturalOpen ? (
          <div
            ref={menuRef}
            className="input-editor-menu"
            data-side={popoverAbove ? 'top' : 'bottom'}
          >
            {menu ? (
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
                      <span className="input-editor-menu-name">{itemLabel(item)}</span>
                      {item.description ? (
                        <span className="input-editor-menu-description">{item.description}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            ) : naturalOpen ? (
              <Command
                shouldFilter={false}
                value={naturalOpen.items[naturalOpen.index]?.command}
                onValueChange={(value) => {
                  const index = naturalOpen.items.findIndex((item) => item.command === value)
                  if (index >= 0 && index !== naturalOpen.index) {
                    setNatural({ ...naturalOpen, index })
                  }
                }}
                onMouseDown={(e) => e.preventDefault()}
                className="h-auto rounded-md! border shadow-md"
                style={{ fontFamily }}
              >
                <CommandList label={d.assist.suggestions}>
                  {naturalOpen.items.map((item) => (
                    <CommandItem
                      key={item.command}
                      value={item.command}
                      className="input-editor-menu-item"
                      onSelect={() => pickNatural(item)}
                    >
                      <span className="input-editor-menu-name">{item.command}</span>
                      {item.description ? (
                        <span className="input-editor-menu-description">{item.description}</span>
                      ) : null}
                    </CommandItem>
                  ))}
                </CommandList>
              </Command>
            ) : (
              <p className="input-editor-tip" aria-live="polite">
                {tipText}
              </p>
            )}
          </div>
        ) : null}
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
            className="input-editor-area min-h-0 resize-none rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent"
            style={{ ...cellStyle, maxHeight: cellHeight ? maxLines * cellHeight : undefined }}
            onChange={(e) => {
              setText(e.target.value)
              setSelection({ start: e.target.selectionStart, end: e.target.selectionEnd })
              walk.current = null
              if (tip !== 'none') setTip('none')
              if (menu) setMenu(null)
              if (!line) termRef.current?.scrollToBottom()
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
            className="input-editor-highlight"
            style={cellStyle}
            aria-hidden="true"
            data-testid="input-editor-highlight"
          >
            {renderDraft(text, commandSet, normal ? clampNormal(text, selection.start) : null)}
            {suggestion ? <span className="input-editor-ghost">{suggestion}</span> : null}
          </div>
        </div>
        {vimEnabled ? (
          <Badge variant="outline" className="input-editor-vim" aria-label={d.inputEditor.vimMode}>
            {vimMode === 'normal' ? d.inputEditor.vimNormal : d.inputEditor.vimInsert}
            {vimPending ? ` ${vimPending}` : ''}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}
