import { CaretDownIcon, NotePencilIcon, PaperPlaneTiltIcon, XIcon } from '@phosphor-icons/react'
import { type JSX, type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem, MenuLabel } from '@/components/common/Menu'
import { StatusLine } from '@/components/common/StatusLine'
import { Button } from '@/components/ui/button'
import { ContextMenuGroup } from '@/components/ui/context-menu'
import { Textarea } from '@/components/ui/textarea'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { useAgentTargets, useNoAgentsText } from '@/lib/agents/useAgentTargets'
import { useDict } from '@/lib/app/useDict'
import type { BarAnchor } from '@/lib/capture/barAnchor'
import {
  closeCapture,
  copyCapture,
  type OpenCapture,
  sendCapture,
} from '@/lib/capture/captureSession'

interface CaptureBarProps {
  workspaceId: string
  paneId: string
  capture: OpenCapture
}

const GAP = 6
const ORIGIN: BarAnchor = { left: 12, top: 12, bottom: 12 }

let lastTargetPaneId: string | null = null

export function CaptureBar({ workspaceId, paneId, capture }: CaptureBarProps): JSX.Element {
  const { adapter, pending, sendRequest, error } = capture
  const anchor = adapter.anchor ?? ORIGIN
  const d = useDict()
  const targets = useAgentTargets(workspaceId)
  const noTargets = useNoAgentsText(workspaceId)
  const rootRef = useRef<HTMLDivElement>(null)
  const [note, setNote] = useState('')
  const [noteOpen, setNoteOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
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
    if (!adapter.takeFocus) return
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
  }, [adapter.takeFocus])

  const seenSendRequest = useRef(sendRequest)
  useEffect(() => {
    if (sendRequest === seenSendRequest.current) return
    seenSendRequest.current = sendRequest
    rootRef.current?.focus({ preventScroll: true })
    setMenuOpen(true)
  }, [sendRequest])

  const send = (target: PickTarget): void => {
    lastTargetPaneId = target.paneId
    setNotice(null)
    void sendCapture(paneId, target, note)
  }

  const sendToLast = (): void => {
    if (targets.length === 0) {
      setNotice(noTargets)
      return
    }
    const target = targets.find((t) => t.paneId === lastTargetPaneId)
    if (target) send(target)
    else setMenuOpen(true)
  }

  const onNoteKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return
    e.preventDefault()
    sendToLast()
  }

  const shownError = error ?? notice

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      role="toolbar"
      aria-label={d.send.barLabel}
      className="motion-fade absolute z-20 flex flex-col gap-1 rounded-md border border-line bg-surface-3 p-1 text-fg text-ui-sm shadow-md outline-none"
      style={{ left: place.left, top: place.top }}
    >
      <div className="flex items-center gap-1">
        <Button size="xs" disabled={pending} onClick={() => void copyCapture(paneId)}>
          {d.send.copy}
        </Button>
        <DropdownMenu
          align="start"
          open={menuOpen}
          onOpenChange={setMenuOpen}
          trigger={
            <Button size="xs" variant="outline" disabled={pending}>
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
                  onClick={() => send(t)}
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
        <IconButton
          size="bar"
          icon={XIcon}
          label={d.send.cancel}
          onClick={() => closeCapture(paneId, 'cancel')}
        />
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
      {shownError ? (
        <StatusLine tone="error" wrap className="rounded-sm">
          {shownError}
        </StatusLine>
      ) : null}
    </div>
  )
}
