import type { UseChatHelpers } from '@ai-sdk/react'
import type {
  AssistProviderInfo,
  ChatContextItem,
} from '@aurigax-ai/ostia-extension-sdk/contract/assist'
import type { Dict } from '@shared/app/dict'
import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react'
import { fmt } from '@/lib/app/useDict'
import { explainSources } from '@/lib/assist/askContext'
import { type MenuAnchor, menuAnchor } from '@/lib/assist/caretPoint'
import {
  activeRow,
  findSlashCommand,
  parseSlash,
  pickChoice,
  pickCommand,
  runSlash,
  type SlashActions,
  type SlashContext,
  type SlashRow,
  slashIndex,
  slashMenu,
  slashRows,
  stepRow,
} from '@/lib/assist/chatSlash'
import { SKILLS_GROUP } from '@/lib/assist/chatTools'
import type { OstiaChatMessage } from '@/lib/assist/chatTransport'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  openSession,
  refreshSessions,
  renameSession,
  startNewSession,
  useChatStore,
} from '@/stores/assist/chatStore'
import { refreshSkills, useChatToolsStore } from '@/stores/assist/chatToolsStore'
import { SLASH_MENU_WIDTH } from './ChatSlashMenu'
import { focusAtEnd } from './useChatFocus'

export type SlashCard = 'help' | null

interface SlashActionsParams {
  d: Dict
  workspaceId: string | null
  sessionId: string
  sourceLabels: Parameters<typeof explainSources>[1]
  ask: (text: string, extra?: ChatContextItem[]) => void
  chat: Pick<UseChatHelpers<OstiaChatMessage>, 'clearError' | 'regenerate'>
  setConfirmClear: (open: boolean) => void
  setSessionsOpen: (open: boolean) => void
  setSlashNotice: (notice: string) => void
  setPickerQuery: (query: string) => void
  setPicking: (open: boolean) => void
  setToolsOpen: (open: boolean) => void
  setModelOpen: (open: boolean) => void
  setCard: (card: SlashCard) => void
}

function createSlashActions({
  d,
  workspaceId,
  sessionId,
  sourceLabels,
  ask,
  chat,
  setConfirmClear,
  setSessionsOpen,
  setSlashNotice,
  setPickerQuery,
  setPicking,
  setToolsOpen,
  setModelOpen,
  setCard,
}: SlashActionsParams): SlashActions {
  const { clearError, regenerate } = chat
  return {
    newChat: () => startNewSession(workspaceId),
    clear: () => setConfirmClear(true),
    openSessions: () => setSessionsOpen(true),
    openSession: (id) => void openSession(workspaceId, id),
    rename: (title) => {
      void renameSession(sessionId, title)
      setSlashNotice(fmt(d.chatSlash.renamed, { title }))
    },
    exportMarkdown: () =>
      void window.ostia.chatSessions.exportMarkdown(sessionId).then((res) => {
        if (res.ok) setSlashNotice(fmt(d.chat.exported, { path: res.path }))
        else if (res.error !== 'cancelled') setSlashNotice(d.chat.exportFailed)
      }),
    retry: () => {
      clearError()
      void regenerate()
    },
    explain: (value) => {
      const source = explainSources(workspaceId, sourceLabels).find((s) => s.value === value)
      if (source) ask(d.chat.explainOutputPrompt, [source.item])
    },
    attach: (query) => {
      setPickerQuery(query)
      setPicking(true)
    },
    openTools: () => setToolsOpen(true),
    applySkill: (name, task) =>
      ask(
        task
          ? fmt(d.chatSlash.skillPrompt, { name, task })
          : fmt(d.chatSlash.skillPromptAlone, { name }),
      ),
    showModel: () => setModelOpen(true),
    showHelp: () => setCard('help'),
  }
}

export interface ChatSlashParams
  extends Omit<SlashActionsParams, 'sourceLabels' | 'setSlashNotice' | 'chat'> {
  chat: Pick<UseChatHelpers<OstiaChatMessage>, 'messages' | 'clearError' | 'regenerate'>
  draft: string
  setDraft: (draft: string) => void
  focused: boolean
  busy: boolean
  last: OstiaChatMessage | undefined
  historyOn: boolean
  scratch: boolean
  provider: AssistProviderInfo | null
  areaRef: RefObject<HTMLTextAreaElement>
  rootRef: RefObject<HTMLDivElement>
}

export function useChatSlash(params: ChatSlashParams) {
  const {
    d,
    workspaceId,
    sessionId,
    draft,
    setDraft,
    focused,
    busy,
    chat,
    last,
    historyOn,
    scratch,
    provider,
    areaRef,
    rootRef,
  } = params
  const { messages } = chat
  const skills = useChatToolsStore((s) => s.skills)
  const skillsOn = useChatToolsStore((s) => !(s.off[sessionId] ?? []).includes(SKILLS_GROUP))
  const skillFolders = useSettingsStore((s) => s.assistant.skillFolders.length)
  const summaries = useChatStore((s) => s.summaries)
  const [slashKey, setSlashKey] = useState<string | null>(null)
  const [slashDismissed, setSlashDismissed] = useState(false)
  const [slashNotice, setSlashNotice] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null)
  const slashing = parseSlash(draft) !== null
  const sourceLabels = useMemo(
    () => ({
      selection: d.chatSlash.sources.selection,
      block: (command: string) => fmt(d.chatSlash.sources.block, { command }),
      output: (command: string) => fmt(d.chatSlash.sources.output, { command }),
    }),
    [d],
  )
  const sources = useMemo(
    () => (slashing ? explainSources(workspaceId, sourceLabels) : []),
    [slashing, workspaceId, sourceLabels],
  )

  useEffect(() => {
    if (!slashing) {
      setSlashDismissed(false)
      return
    }
    void refreshSessions()
    void refreshSkills()
  }, [slashing])

  const slashCtx: SlashContext = {
    busy,
    messageCount: messages.length,
    lastRole: last?.role ?? null,
    recording: historyOn && !scratch,
    provider: provider !== null,
    tools: Boolean(provider?.tools),
    skillFolders,
    skills,
    skillsOn,
    sessions: summaries.filter((s) => s.id !== sessionId),
    sources: sources.map((s) => ({ value: s.value, label: s.item.label })),
  }
  const menu =
    focused && !slashDismissed
      ? slashMenu(draft, slashCtx, (id) => d.chatSlash.commands[id].title)
      : null
  const rows = menu ? slashRows(menu, slashCtx) : []
  const active = activeRow(rows, slashKey)
  const menuOpen = menu !== null

  useLayoutEffect(() => {
    const root = rootRef.current
    const area = areaRef.current
    if (!menuOpen || !root || !area) return
    setAnchor(menuAnchor(root, area, slashIndex(draft), SLASH_MENU_WIDTH))
  }, [menuOpen, draft, rootRef, areaRef])

  const slashActions = createSlashActions({ ...params, sourceLabels, setSlashNotice })

  const executeSlash = (text: string): boolean => {
    const outcome = runSlash(text, slashCtx, slashActions)
    if (!outcome) return false
    setSlashKey(null)
    if (outcome.ran) setDraft('')
    else setSlashNotice(d.chatSlash.reasons[outcome.reason])
    return true
  }

  const pickRow = (row: SlashRow, tab: boolean): void => {
    if (row.reason) {
      setSlashNotice(d.chatSlash.reasons[row.reason])
      return
    }
    const pick = row.choice
      ? pickChoice(row.command, row.choice)
      : pickCommand(row.command, slashCtx, tab)
    if (pick.kind === 'run') {
      executeSlash(pick.draft)
      return
    }
    setDraft(pick.draft)
    setSlashKey(null)
    requestAnimationFrame(() => focusAtEnd(areaRef.current))
  }

  const onSlashKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing) return false
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if (menu && plain && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setSlashKey(stepRow(rows, active?.key, e.key === 'ArrowDown' ? 1 : -1))
      return true
    }
    if (menu && plain && (e.key === 'Enter' || e.key === 'Tab')) {
      if (active) pickRow(active, e.key === 'Tab')
      return true
    }
    if (menu && e.key === 'Escape') {
      setSlashDismissed(true)
      return true
    }
    const parsed = plain && e.key === 'Enter' ? parseSlash(draft) : null
    if (parsed && findSlashCommand(parsed.name)) {
      executeSlash(draft)
      return true
    }
    return false
  }
  return {
    slashNotice,
    setSlashNotice,
    menu,
    rows,
    active,
    menuOpen,
    anchor,
    setSlashKey,
    executeSlash,
    pickRow,
    onSlashKey,
  }
}

export type ChatSlash = ReturnType<typeof useChatSlash>
