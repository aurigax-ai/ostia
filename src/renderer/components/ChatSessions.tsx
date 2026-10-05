import { cn } from '@/lib/utils'
import {
  CaretDownIcon,
  DownloadSimpleIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type { ChatSessionSummary } from '@shared/chatSessions'
import { type RelativeStep, formatRelative } from '@shared/relativeTime'
import { useEffect, useMemo, useState } from 'react'
import { fmt, useDict } from '../i18n/useDict'
import {
  deleteSession,
  openSession,
  refreshSessions,
  renameSession,
  startNewSession,
  useChatStore,
} from '../stores/chatStore'
import { useSettingsStore } from '../stores/settingsStore'
import { IconButton } from './IconButton'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Switch } from './ui/switch'

const RELATIVE_STEPS: RelativeStep[] = [
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]

export function relativeTime(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000)
  const beyondMinute = Math.abs(seconds) >= 60 ? seconds : 0
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' })
  return formatRelative(beyondMinute, RELATIVE_STEPS, format)
}

export function filterSessions(
  list: readonly ChatSessionSummary[],
  query: string,
): ChatSessionSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]
  return list.filter((s) => s.title.toLowerCase().includes(q))
}

export function ChatSessions({
  workspaceId,
  sessionId,
  open,
  onOpenChange: setOpen,
}: {
  workspaceId: string | null
  sessionId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const recording = useSettingsStore((s) => s.assistant.chatHistory)
  const title = useChatStore((s) => s.meta[sessionId]?.title) || d.chat.untitled
  const summaries = useChatStore((s) => s.summaries)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<ChatSessionSummary | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (open) void refreshSessions()
  }, [open])

  const shown = useMemo(() => filterSessions(summaries, query), [summaries, query])
  const now = Date.now()

  const exportSession = (id: string): void => {
    void window.ostia.chatSessions.exportMarkdown(id).then((res) => {
      if (res.ok) setMessage(fmt(d.chat.exported, { path: res.path }))
      else if (res.error !== 'cancelled') setMessage(d.chat.exportFailed)
    })
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="xs"
              className="min-w-0 max-w-64 justify-start font-medium text-fg"
              aria-label={fmt(d.chat.sessionsButton, { title })}
            >
              <span className="truncate">{title}</span>
              <CaretDownIcon className="shrink-0 text-fg-muted" />
            </Button>
          }
        />
        <PopoverContent align="start" className="chat-sessions w-80 gap-2 p-2">
          <div className="flex items-center gap-1">
            <Input
              value={query}
              aria-label={d.chat.searchSessions}
              placeholder={d.chat.searchSessions}
              className="h-7"
              onChange={(e) => setQuery(e.target.value)}
            />
            <IconButton
              size="bar"
              icon={NotePencilIcon}
              label={d.chat.newChat}
              onClick={() => {
                startNewSession(workspaceId)
                setOpen(false)
              }}
            />
          </div>
          <ul aria-label={d.chat.sessions} className="flex max-h-72 flex-col overflow-y-auto">
            {shown.length === 0 ? (
              <li className="px-2 py-3 text-fg-muted text-ui-sm">
                {summaries.length === 0 ? d.chat.noSessions : d.chat.noMatch}
              </li>
            ) : (
              shown.map((s) => (
                <li
                  key={s.id}
                  className={cn(
                    'group/session flex items-center gap-1 rounded-sm px-1.5 py-1 hover:bg-surface-3',
                    s.id === sessionId && 'bg-surface-2',
                  )}
                  aria-current={s.id === sessionId || undefined}
                >
                  {editing === s.id ? (
                    <RenameField
                      initial={s.title}
                      onDone={(next) => {
                        setEditing(null)
                        if (next !== null) void renameSession(s.id, next)
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col items-start text-left"
                      onClick={() => {
                        void openSession(workspaceId, s.id)
                        setOpen(false)
                      }}
                    >
                      <span className="w-full truncate text-fg text-ui-sm">{s.title}</span>
                      <span className="text-fg-muted text-ui-xs">
                        {relativeTime(s.updatedAt, now, locale)} ·{' '}
                        {s.messageCount === 1
                          ? d.chat.oneMessage
                          : fmt(d.chat.messages, { count: s.messageCount })}
                      </span>
                    </button>
                  )}
                  <span className="flex shrink-0 items-center opacity-0 group-focus-within/session:opacity-100 group-hover/session:opacity-100">
                    <IconButton
                      icon={PencilSimpleIcon}
                      label={d.chat.rename}
                      onClick={() => setEditing(s.id)}
                    />
                    <IconButton
                      icon={DownloadSimpleIcon}
                      label={d.chat.export}
                      onClick={() => exportSession(s.id)}
                    />
                    <IconButton
                      icon={TrashIcon}
                      label={d.chat.delete}
                      onClick={() => setConfirming(s)}
                    />
                  </span>
                </li>
              ))
            )}
          </ul>
          {message ? (
            <p aria-live="polite" className="truncate px-1 text-fg-muted text-ui-xs">
              {message}
            </p>
          ) : null}
          <div className="flex items-center justify-between gap-2 border-line border-t px-1 pt-2 text-fg text-ui-sm">
            <span>{d.chat.saveHistory}</span>
            <Switch
              checked={recording}
              aria-label={d.chat.saveHistory}
              onCheckedChange={(on) => useSettingsStore.getState().setChatHistory(on)}
            />
          </div>
        </PopoverContent>
      </Popover>
      <Dialog
        open={confirming !== null}
        onOpenChange={(o) => {
          if (!o) setConfirming(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{d.chat.deleteTitle}</DialogTitle>
            <DialogDescription>
              {fmt(d.chat.deleteBody, { title: confirming?.title ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>
              {d.chat.cancel}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                const target = confirming
                setConfirming(null)
                if (target) void deleteSession(target.id)
              }}
            >
              {d.chat.delete}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function RenameField({
  initial,
  onDone,
}: {
  initial: string
  onDone: (title: string | null) => void
}): JSX.Element {
  const d = useDict()
  const [value, setValue] = useState(initial)
  return (
    <form
      className="flex min-w-0 flex-1"
      onSubmit={(e) => {
        e.preventDefault()
        onDone(value.trim() ? value : null)
      }}
    >
      <Input
        autoFocus
        value={value}
        aria-label={d.chat.renameLabel}
        className="h-7"
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => onDone(value.trim() && value !== initial ? value : null)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            onDone(null)
          }
        }}
      />
    </form>
  )
}
