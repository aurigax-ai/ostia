import { CaretDownIcon, CaretRightIcon, CropIcon, WarningIcon } from '@phosphor-icons/react'
import {
  isWebLink,
  keepErrors,
  type PreviewError,
  type PreviewOpened,
  type PreviewStopReason,
  previewErrorLine,
} from '@shared/artifacts/htmlPreview'
import type { PickBox } from '@shared/browser/pick'
import type { RegionView } from '@shared/browser/regionCapture'
import type { SelectionCapture } from '@shared/browser/selection'
import {
  type Dispatch,
  type MutableRefObject,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from 'react'
import { RegionCropBox, RegionCropOverlay } from '@/components/browser/RegionCropOverlay'
import { EmptyState } from '@/components/common/EmptyState'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { StatusAction, StatusLine, useDismissed } from '@/components/common/StatusLine'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group'
import { anchorWithin, type BarAnchor } from '@/lib/agents/barAnchor'
import { fmt, useDict } from '@/lib/app/useDict'
import { openBrowserAs } from '@/lib/browser/browserProfile'
import { useGuestReady } from '@/lib/panes/paneFocus'
import { previewTheme } from '@/lib/theme/previewTheme'
import { useEffectiveThemeId } from '@/lib/theme/theme'
import { retryPendingFocus } from '@/stores/workspaces/surfaceSlotsStore'
import { FloatPill, FloatPillButton } from './FloatPill'

type Stopped = PreviewStopReason | 'failed'

const SLEEPS: readonly PreviewStopReason[] = ['hidden', 'limit']

function errorText(blocked: string, error: PreviewError): string {
  return error.kind === 'blocked' ? fmt(blocked, { host: error.message }) : previewErrorLine(error)
}

function PreviewErrorStrip({
  errors,
  expanded,
  setExpanded,
  onSendErrors,
}: {
  errors: PreviewError[]
  expanded: boolean
  setExpanded: Dispatch<SetStateAction<boolean>>
  onSendErrors?: (count: number, text: string) => void
}): JSX.Element {
  const d = useDict()
  const report = (): string => errors.map((error) => errorText(d.preview.blocked, error)).join('\n')
  const newest = errors[errors.length - 1]

  return (
    <>
      {newest ? (
        <div className="preview-strip" data-testid="preview-errors">
          <button
            type="button"
            className="preview-strip-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((open) => !open)}
          >
            <CaretRightIcon size={16} className={`file-twisty${expanded ? ' open' : ''}`} />
            <WarningIcon size={16} aria-hidden />
            <span className="preview-strip-count">
              {fmt(errors.length === 1 ? d.preview.oneError : d.preview.errors, {
                count: errors.length,
              })}
            </span>
            <span className="preview-strip-newest">{errorText(d.preview.blocked, newest)}</span>
          </button>
          {onSendErrors ? (
            <ButtonGroup aria-label={d.preview.errorActions}>
              <Button
                variant="outline"
                size="xs"
                onClick={() => onSendErrors(errors.length, report())}
              >
                {d.preview.sendError}
              </Button>
              <ButtonGroupSeparator />
              <DropdownMenu
                trigger={
                  <Button variant="outline" size="icon-xs" aria-label={d.preview.errorActions}>
                    <CaretDownIcon aria-hidden />
                  </Button>
                }
              >
                <MenuItem onClick={() => void navigator.clipboard.writeText(report())}>
                  {d.preview.copyErrors}
                </MenuItem>
              </DropdownMenu>
            </ButtonGroup>
          ) : (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void navigator.clipboard.writeText(report())}
            >
              {d.preview.copyErrors}
            </Button>
          )}
        </div>
      ) : null}
      {newest && expanded ? (
        <ol className="preview-error-list" data-testid="preview-error-list">
          {errors.map((error, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: errors are append-only text lines without ids
            <li key={index}>{errorText(d.preview.blocked, error)}</li>
          ))}
        </ol>
      ) : null}
    </>
  )
}

function VitalsLine({
  vitals,
  stop,
}: {
  vitals: { responding: boolean; busy: boolean }
  stop: () => void
}): JSX.Element | null {
  const d = useDict()
  const [dismissed, dismiss] = useDismissed(vitals.responding ? 'busy' : 'stuck')
  if (dismissed) return null
  return (
    <StatusLine
      role="alert"
      tone="warn"
      data-testid={vitals.responding ? 'preview-busy' : 'preview-not-responding'}
      actions={<StatusAction onClick={stop}>{d.preview.stop}</StatusAction>}
      onDismiss={dismiss}
    >
      {vitals.responding ? d.preview.busy : d.preview.notResponding}
    </StatusLine>
  )
}

function PreviewBars({
  workspaceId,
  opened,
  vitals,
  link,
  setLink,
  stop,
}: {
  workspaceId: string
  opened: PreviewOpened | null
  vitals: { responding: boolean; busy: boolean }
  link: string | null
  setLink: Dispatch<SetStateAction<string | null>>
  stop: () => void
}): JSX.Element {
  const d = useDict()
  return (
    <>
      {opened && (!vitals.responding || vitals.busy) ? (
        <VitalsLine vitals={vitals} stop={stop} />
      ) : null}
      {link ? (
        <StatusLine
          wrap
          role="alert"
          data-testid="preview-link"
          actions={
            isWebLink(link) ? (
              <StatusAction
                onClick={() => {
                  openBrowserAs(workspaceId, link, 'agent')
                  setLink(null)
                }}
              >
                {d.preview.openInBrowser}
              </StatusAction>
            ) : null
          }
          onDismiss={() => setLink(null)}
        >
          <span className="select-text font-mono">{link}</span>
        </StatusLine>
      ) : null}
    </>
  )
}

type SendRegion = (
  capture: SelectionCapture,
  image: Uint8Array,
  anchor?: BarAnchor,
  onClose?: () => void,
) => void

function regionAnchor(frame: HTMLElement | null, rect: PickBox): BarAnchor | undefined {
  const container = frame?.closest('.html-preview')?.parentElement
  if (!frame || !container) return undefined
  const origin = frame.getBoundingClientRect()
  return anchorWithin(container, {
    left: origin.left + rect.x,
    top: origin.top + rect.y,
    bottom: origin.top + rect.y + rect.height,
  })
}

function usePreviewRegion({
  opened,
  filePath,
  frame,
  onSendRegion,
}: {
  opened: PreviewOpened | null
  filePath: string
  frame: HTMLElement | null
  onSendRegion?: SendRegion
}) {
  const [picking, setPicking] = useState(false)
  const [held, setHeld] = useState<PickBox | null>(null)
  const region = async (rect: PickBox, view: RegionView): Promise<void> => {
    setPicking(false)
    if (!opened || !onSendRegion) return
    const captured = await window.ostia.preview.capture(opened.id, rect)
    if (!captured) return
    onSendRegion(
      {
        kind: 'preview-region',
        file: filePath,
        viewWidth: view.width,
        viewHeight: view.height,
        region: captured.region,
        version: null,
      },
      captured.image,
      regionAnchor(frame, rect),
      () => setHeld((current) => (current === rect ? null : current)),
    )
    setHeld(rect)
  }

  return { picking, setPicking, region, held }
}

export function HtmlPreview({
  workspaceId,
  paneId,
  filePath,
  visible,
  onSendErrors,
  onSendRegion,
  focusRef,
  mode,
}: {
  workspaceId: string
  paneId: string
  filePath: string
  visible: boolean
  focusRef?: MutableRefObject<HTMLElement | null>
  mode?: ReactNode
  onSendErrors?: (count: number, text: string) => void
  onSendRegion?: SendRegion
}): JSX.Element {
  const d = useDict()
  const [opened, setOpened] = useState<PreviewOpened | null>(null)
  const [stopped, setStopped] = useState<Stopped | null>(null)
  const [errors, setErrors] = useState<PreviewError[]>([])
  const [expanded, setExpanded] = useState(false)
  const [vitals, setVitals] = useState({ responding: true, busy: false })
  const [link, setLink] = useState<string | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const { picking, setPicking, region, held } = usePreviewRegion({
    opened,
    filePath,
    frame: webview?.parentElement ?? null,
    onSendRegion,
  })
  const readyWebview = useGuestReady(webview)
  useEffect(() => {
    if (!focusRef) return
    focusRef.current = readyWebview
    retryPendingFocus()
    return () => {
      focusRef.current = null
    }
  }, [focusRef, readyWebview])
  const openedRef = useRef<PreviewOpened | null>(null)
  openedRef.current = opened
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const wanted = visible && stopped === null

  useEffect(() => {
    if (!wanted || opened) return
    let alive = true
    void window.ostia.preview.open(paneId, filePath, previewTheme()).then((res) => {
      if (!alive) {
        if (res) window.ostia.preview.close(res.id)
        return
      }
      if (res) setOpened(res)
      else setStopped('failed')
    })
    return () => {
      alive = false
    }
  }, [wanted, opened, paneId, filePath])

  useEffect(() => {
    if (!opened) return
    const { id } = opened
    return () => window.ostia.preview.close(id)
  }, [opened])

  const themeId = useEffectiveThemeId()
  const builtFor = useRef(themeId)
  useEffect(() => {
    if (builtFor.current === themeId) return
    builtFor.current = themeId
    setOpened(null)
  }, [themeId])

  useEffect(() => {
    if (opened) window.ostia.preview.shown(opened.id, visible)
  }, [opened, visible])

  useEffect(
    () =>
      window.ostia.preview.onEvent((event) => {
        if (event.id !== openedRef.current?.id) return
        if (event.type === 'loading') {
          setErrors([])
          setExpanded(false)
          setLink(null)
        } else if (event.type === 'error') {
          setErrors((kept) => keepErrors(kept, event.error))
        } else if (event.type === 'vitals') {
          setVitals({ responding: event.responding, busy: event.busy })
        } else if (event.type === 'link') {
          setLink(event.url)
        } else {
          setOpened(null)
          setVitals({ responding: true, busy: false })
          setLink(null)
          const sleeps = SLEEPS.includes(event.reason)
          if (!sleeps || (event.reason === 'limit' && visibleRef.current)) setStopped(event.reason)
        }
      }),
    [],
  )

  const stop = (): void => {
    if (opened) window.ostia.preview.stop(opened.id)
  }
  const reload = (): void => {
    setErrors([])
    setExpanded(false)
    setStopped(null)
  }

  const capture = onSendRegion && opened && !stopped
  const pill =
    capture || mode ? (
      <FloatPill label={d.preview.controls}>
        {capture ? (
          <FloatPillButton
            icon={CropIcon}
            label={d.preview.captureRegion}
            aria-pressed={picking}
            onClick={() => setPicking((on) => !on)}
          />
        ) : null}
        {mode}
      </FloatPill>
    ) : null

  return (
    <div className="html-preview" data-testid="html-preview" data-live={opened ? 'true' : 'false'}>
      <PreviewErrorStrip
        errors={errors}
        expanded={expanded}
        setExpanded={setExpanded}
        onSendErrors={onSendErrors}
      />
      <PreviewBars
        workspaceId={workspaceId}
        opened={opened}
        vitals={vitals}
        link={link}
        setLink={setLink}
        stop={stop}
      />
      {stopped ? (
        <EmptyState
          variant="surface"
          size="sm"
          className="flex-1"
          data-testid="preview-stopped"
          icon={<WarningIcon aria-hidden />}
          title={d.preview.stopped[stopped]}
          actions={
            <Button variant="outline" size="sm" onClick={reload}>
              {d.preview.reload}
            </Button>
          }
        />
      ) : opened ? (
        <div className="preview-frame">
          <webview
            key={opened.url}
            ref={setWebview}
            className="preview-webview"
            src={opened.url}
            partition={opened.partition}
          />
          {held ? <RegionCropBox rect={held} /> : null}
          {picking ? (
            <RegionCropOverlay
              label={d.preview.regionHint}
              onDone={(rect, view) => void region(rect, view)}
              onCancel={() => setPicking(false)}
            />
          ) : null}
        </div>
      ) : null}
      {pill}
    </div>
  )
}
