import { CaretDownIcon, NotePencilIcon, PaperPlaneTiltIcon, XIcon } from '@phosphor-icons/react'
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem, MenuLabel } from '@/components/common/Menu'
import { StatusLine } from '@/components/common/StatusLine'
import { Button } from '@/components/ui/button'
import { ContextMenuGroup } from '@/components/ui/context-menu'
import { Textarea } from '@/components/ui/textarea'
import type { BarAnchor } from '@/lib/agents/barAnchor'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { useAgentTargets, useNoAgentsText } from '@/lib/agents/useAgentTargets'
import { useDict } from '@/lib/app/useDict'

export interface RegionActionBarProps {
  workspaceId: string
  anchor: BarAnchor
  onCopy: () => Promise<string | null>
  onSend: (target: PickTarget, note: string) => Promise<void>
  onClose: () => void
  takeFocus?: boolean
  sendRequest?: number
}

const GAP = 6
const STATUS_MS = 6000
const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])

let lastTargetPaneId: string | null = null

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[role="menu"]') !== null
}

export function RegionActionBar({
  workspaceId,
  anchor,
  onCopy,
  onSend,
  onClose,
  takeFocus = true,
  sendRequest = 0,
}: RegionActionBarProps): JSX.Element {
  const d = useDict()
  const targets = useAgentTargets(workspaceId)
  const noTargets = useNoAgentsText(workspaceId)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const [note, setNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [place, setPlace] = useState({ left: anchor.left, top: anchor.bottom + GAP })

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    const placeBar = (): void => {
      const parent = root.offsetParent
      if (!parent) return
      const below = anchor.bottom + GAP
      const above = anchor.top - GAP - root.offsetHeight
      const fitsBelow = below + root.offsetHeight <= parent.clientHeight
      setPlace({
        left: Math.max(0, Math.min(anchor.left, parent.clientWidth - root.offsetWidth)),
        top: fitsBelow || above < 0 ? below : above,
      })
    }
    placeBar()
    const observer = new ResizeObserver(placeBar)
    observer.observe(root)
    return () => observer.disconnect()
  }, [anchor.left, anchor.top, anchor.bottom])

  useEffect(() => {
    if (copied !== null) return
    const close = (): void => closeRef.current()
    const inside = (target: EventTarget | null): boolean =>
      target instanceof Node && (rootRef.current?.contains(target) ?? false)
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (inMenu(e.target)) return
        if (inside(e.target)) {
          e.preventDefault()
          e.stopPropagation()
        }
        close()
        return
      }
      if (MODIFIER_KEYS.has(e.key) || e.ctrlKey || e.metaKey) return
      if (!inside(e.target) && !inMenu(e.target)) close()
    }
    const onOutside = (e: Event): void => {
      if (!inside(e.target) && !inMenu(e.target)) close()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('scroll', onOutside, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onOutside, true)
      document.removeEventListener('scroll', onOutside, true)
    }
  }, [copied])

  useEffect(() => {
    if (copied !== null || !takeFocus) return
    const root = rootRef.current
    const origin = document.activeElement
    root?.focus({ preventScroll: true })
    return () => {
      const active = document.activeElement
      const free = !active || active === document.body || active === root
      if (free && origin instanceof HTMLElement && origin.isConnected) {
        origin.focus({ preventScroll: true })
      }
    }
  }, [copied, takeFocus])

  const seenSendRequest = useRef(sendRequest)
  useEffect(() => {
    if (sendRequest === seenSendRequest.current) return
    seenSendRequest.current = sendRequest
    rootRef.current?.focus({ preventScroll: true })
    setMenuOpen(true)
  }, [sendRequest])

  useEffect(() => {
    if (copied === null) return
    const timer = window.setTimeout(() => closeRef.current(), STATUS_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(false)
    }
  }, [])

  const copy = (): Promise<void> =>
    run(async () => {
      const status = await onCopy()
      if (status === null) onClose()
      else setCopied(status)
    })

  const send = (target: PickTarget): Promise<void> =>
    run(async () => {
      lastTargetPaneId = target.paneId
      await onSend(target, note)
      onClose()
    })

  const sendToLast = (): void => {
    if (targets.length === 0) {
      setError(noTargets)
      return
    }
    const target = targets.find((t) => t.paneId === lastTargetPaneId)
    if (target) void send(target)
    else setMenuOpen(true)
  }

  const onNoteKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    sendToLast()
  }

  if (copied !== null) {
    return (
      <div className="absolute inset-x-0 top-0 z-20">
        <StatusLine onDismiss={onClose}>{copied}</StatusLine>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="toolbar"
      aria-label={d.send.barLabel}
      className="motion-enter absolute z-20 flex origin-top-left flex-col gap-1 rounded-md border border-line bg-surface-3 p-1 text-fg text-ui-sm shadow-md outline-none"
      style={{ left: place.left, top: place.top }}
    >
      <div className="flex items-center gap-1">
        <Button size="xs" disabled={busy} onClick={() => void copy()}>
          {d.send.copy}
        </Button>
        <DropdownMenu
          align="start"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={
            <Button size="xs" variant="outline" disabled={busy}>
              <PaperPlaneTiltIcon aria-hidden />
              {d.send.title}
              <CaretDownIcon aria-hidden />
            </Button>
          }
        >
          <ContextMenuGroup>
            <MenuLabel>{d.send.title}</MenuLabel>
            {targets.length === 0 ? (
              <MenuItem disabled>{noTargets}</MenuItem>
            ) : (
              targets.map((t) => (
                <MenuItem
                  key={t.paneId}
                  leading={<span className={`dot ${t.state === 'none' ? '' : t.state}`} />}
                  onClick={() => void send(t)}
                >
                  {t.title}
                </MenuItem>
              ))
            )}
          </ContextMenuGroup>
        </DropdownMenu>
        <IconButton
          size="bar"
          icon={NotePencilIcon}
          label={d.send.addNote}
          aria-pressed={note.trim() !== ''}
          onClick={() => setNoteOpen((open) => !open)}
        />
        <IconButton size="bar" icon={XIcon} label={d.send.cancel} onClick={onClose} />
      </div>
      {noteOpen ? (
        <div className="flex w-80 flex-col gap-1 p-1">
          <Textarea
            autoFocus
            value={note}
            aria-label={d.send.addNote}
            placeholder={d.send.notePlaceholder}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={onNoteKeyDown}
            className="min-h-16 text-ui-sm"
          />
          <span className="text-fg-muted text-ui-xs">{d.send.noteHint}</span>
        </div>
      ) : null}
      {error ? (
        <StatusLine tone="error" wrap className="rounded-sm">
          {error}
        </StatusLine>
      ) : null}
    </div>
  )
}
