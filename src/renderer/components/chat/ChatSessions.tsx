import {
  ClockCounterClockwiseIcon,
  DownloadSimpleIcon,
  NotePencilIcon,
  PencilSimpleIcon,
  TrashIcon,
} from '@phosphor-icons/react'
import type { ChatSessionSummary } from '@shared/assist/chatSessions'
import { type JSX, useEffect, useMemo, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { relativeTimeText } from '@/lib/app/localeFormat'
import { fmt, useDict } from '@/lib/app/useDict'
import { cn } from '@/lib/utils'
import { useSettingsStore } from '@/stores/app/settingsStore'
import {
  deleteSession,
  openSession,
  refreshSessions,
  renameSession,
  startNewSession,
  useChatStore,
} from '@/stores/assist/chatStore'

function filterSessions(list: readonly ChatSessionSummary[], query: string): ChatSessionSummary[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...list]
  return list.filter((s) => s.title.toLowerCase().includes(q))
}

export function ChatSessions({
  workspaceId,
  sessionId,
  recording,
  scratch,
  open,
  onOpenChange: setOpen,
}: {
  workspaceId: string | null
  sessionId: string
  recording: boolean
  scratch: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
}): JSX.Element {
  const d = useDict()
  const locale = useSettingsStore((s) => s.locale)
  const saveHistory = useSettingsStore((s) => s.assistant.chatHistory)
  const sessionsName = recording ? d.chat.sessionsRecording : d.chat.sessions
  const sessionsHint = scratch ? d.chat.scratchHint : recording ? null : d.chat.notRecordingHint
  const sessionsLabel = sessionsHint ? `${sessionsName}. ${sessionsHint}` : sessionsName
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
        <span className="relative flex">
          <PopoverTrigger
            render={
              <IconButton size="bar" icon={ClockCounterClockwiseIcon} label={sessionsLabel} />
            }
          />
          {recording ? (
            <span
              aria-hidden
              data-testid="chat-recording-dot"
              className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-ok"
            />
          ) : null}
        </span>
        <PopoverContent align="end" className="chat-sessions w-80 gap-2 p-2">
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
                <SessionRow
                  key={s.id}
                  session={s}
                  current={s.id === sessionId}
                  editing={editing === s.id}
                  now={now}
                  locale={locale}
                  onRenamed={(next) => {
                    setEditing(null)
                    if (next !== null) void renameSession(s.id, next)
                  }}
                  onOpen={() => {
                    void openSession(workspaceId, s.id)
                    setOpen(false)
                  }}
                  onEdit={() => setEditing(s.id)}
                  onExport={() => exportSession(s.id)}
                  onDelete={() => setConfirming(s)}
                />
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
              checked={saveHistory}
              aria-label={d.chat.saveHistory}
              onCheckedChange={(on) => useSettingsStore.getState().setChatHistory(on)}
            />
          </div>
        </PopoverContent>
      </Popover>
      <DeleteSessionDialog confirming={confirming} onClose={() => setConfirming(null)} />
    </>
  )
}

function SessionRow({
  session: s,
  current,
  editing,
  now,
  locale,
  onRenamed,
  onOpen,
  onEdit,
  onExport,
  onDelete,
}: {
  session: ChatSessionSummary
  current: boolean
  editing: boolean
  now: number
  locale: string
  onRenamed: (title: string | null) => void
  onOpen: () => void
  onEdit: () => void
  onExport: () => void
  onDelete: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <li
      className={cn(
        'group/session flex items-center gap-1 rounded-sm px-1.5 py-1 hover:bg-surface-3',
        current && 'bg-surface-2',
      )}
      aria-current={current || undefined}
    >
      {editing ? (
        <RenameField initial={s.title} onDone={onRenamed} />
      ) : (
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          onClick={onOpen}
        >
          <span className="w-full truncate text-fg text-ui-sm">{s.title}</span>
          <span className="text-fg-muted text-ui-xs">
            {relativeTimeText(s.updatedAt, now, locale)} ·{' '}
            {s.messageCount === 1
              ? d.chat.oneMessage
              : fmt(d.chat.messages, { count: s.messageCount })}
          </span>
        </button>
      )}
      <span className="flex shrink-0 items-center opacity-0 group-focus-within/session:opacity-100 group-hover/session:opacity-100">
        <IconButton icon={PencilSimpleIcon} label={d.chat.rename} onClick={onEdit} />
        <IconButton icon={DownloadSimpleIcon} label={d.chat.export} onClick={onExport} />
        <IconButton icon={TrashIcon} label={d.chat.delete} onClick={onDelete} />
      </span>
    </li>
  )
}

function DeleteSessionDialog({
  confirming,
  onClose,
}: {
  confirming: ChatSessionSummary | null
  onClose: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <Dialog
      open={confirming !== null}
      onOpenChange={(o) => {
        if (!o) onClose()
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
          <Button variant="outline" size="sm" onClick={() => onClose()}>
            {d.chat.cancel}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              const target = confirming
              onClose()
              if (target) void deleteSession(target.id)
            }}
          >
            {d.chat.delete}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
