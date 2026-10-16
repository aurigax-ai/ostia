import { ATTENTION_ALERT } from '@/components/agents/attentionStyles'
import { IconButton } from '@/components/common/IconButton'
import { DropdownMenu, MenuItem } from '@/components/common/Menu'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { ButtonGroup, ButtonGroupSeparator } from '@/components/ui/button-group'
import { fmt, useDict } from '@/lib/app/useDict'
import { openBrowserAs } from '@/lib/browser/browserProfile'
import { useGuestReady } from '@/lib/panes/paneFocus'
import { previewTheme } from '@/lib/theme/previewTheme'
import { useEffectiveThemeId } from '@/lib/theme/theme'
import { cn } from '@/lib/utils'
import { retryPendingFocus } from '@/stores/workspaces/surfaceSlotsStore'
import { CaretDownIcon, CaretRightIcon, WarningIcon, XIcon } from '@phosphor-icons/react'
import {
  type PreviewError,
  type PreviewOpened,
  type PreviewStopReason,
  isWebLink,
  keepErrors,
  previewErrorLine,
} from '@shared/artifacts/htmlPreview'
import type { SelectionCapture } from '@shared/browser/selection'
import { type MutableRefObject, useEffect, useRef, useState } from 'react'
import {
  type PickedRegion,
  PreviewRegionOverlay,
  PreviewRegionTools,
  type RegionAction,
} from './PreviewRegion'

type Stopped = PreviewStopReason | 'failed'

const SLEEPS: readonly PreviewStopReason[] = ['hidden', 'limit']

function errorText(blocked: string, error: PreviewError): string {
  return error.kind === 'blocked' ? fmt(blocked, { host: error.message }) : previewErrorLine(error)
}

export function HtmlPreview({
  workspaceId,
  paneId,
  filePath,
  visible,
  onSendErrors,
  onSendRegion,
  focusRef,
}: {
  workspaceId: string
  paneId: string
  filePath: string
  visible: boolean
  focusRef?: MutableRefObject<HTMLElement | null>
  onSendErrors?: (count: number, text: string) => void
  onSendRegion?: (capture: SelectionCapture, image: Uint8Array) => void
}): JSX.Element {
  const d = useDict()
  const [opened, setOpened] = useState<PreviewOpened | null>(null)
  const [stopped, setStopped] = useState<Stopped | null>(null)
  const [errors, setErrors] = useState<PreviewError[]>([])
  const [expanded, setExpanded] = useState(false)
  const [vitals, setVitals] = useState({ responding: true, busy: false })
  const [link, setLink] = useState<string | null>(null)
  const [picking, setPicking] = useState<RegionAction | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
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
  const region = async (picked: PickedRegion | null): Promise<void> => {
    const action = picking
    setPicking(null)
    if (!picked || !opened || !action) return
    if (action === 'copy') {
      await window.ostia.preview.copyRegion(opened.id, picked.region)
      return
    }
    const captured = await window.ostia.preview.capture(opened.id, picked.region)
    if (!captured || !onSendRegion) return
    onSendRegion(
      {
        kind: 'preview-region',
        file: filePath,
        viewWidth: picked.viewWidth,
        viewHeight: picked.viewHeight,
        region: captured.region,
        version: null,
      },
      captured.image,
    )
  }
  const report = (): string => errors.map((error) => errorText(d.preview.blocked, error)).join('\n')
  const newest = errors[errors.length - 1]

  return (
    <div className="html-preview" data-testid="html-preview" data-live={opened ? 'true' : 'false'}>
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
      {opened && !vitals.responding ? (
        <Alert className={cn(ATTENTION_ALERT, 'preview-bar')} data-testid="preview-not-responding">
          <span className="min-w-0 flex-1">{d.preview.notResponding}</span>
          <Button variant="outline" size="xs" onClick={stop}>
            {d.preview.stop}
          </Button>
        </Alert>
      ) : null}
      {opened && vitals.responding && vitals.busy ? (
        <Alert className={cn(ATTENTION_ALERT, 'preview-bar')} data-testid="preview-busy">
          <span className="min-w-0 flex-1">{d.preview.busy}</span>
          <Button variant="outline" size="xs" onClick={stop}>
            {d.preview.stop}
          </Button>
        </Alert>
      ) : null}
      {link ? (
        <Alert className={cn(ATTENTION_ALERT, 'preview-bar')} data-testid="preview-link">
          <span className="preview-link-url min-w-0 flex-1">{link}</span>
          {isWebLink(link) ? (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                openBrowserAs(workspaceId, link, 'agent')
                setLink(null)
              }}
            >
              {d.preview.openInBrowser}
            </Button>
          ) : null}
          <IconButton icon={XIcon} label={d.preview.dismiss} onClick={() => setLink(null)} />
        </Alert>
      ) : null}
      {stopped ? (
        <div className="preview-stopped" data-testid="preview-stopped">
          <span>{d.preview.stopped[stopped]}</span>
          <Button variant="outline" size="xs" onClick={reload}>
            {d.preview.reload}
          </Button>
        </div>
      ) : opened ? (
        <div className="preview-frame">
          {onSendRegion ? <PreviewRegionTools onPick={setPicking} /> : null}
          <webview
            key={opened.url}
            ref={setWebview}
            className="preview-webview"
            src={opened.url}
            partition={opened.partition}
          />
          {picking ? <PreviewRegionOverlay onDone={(picked) => void region(picked)} /> : null}
        </div>
      ) : null}
    </div>
  )
}
