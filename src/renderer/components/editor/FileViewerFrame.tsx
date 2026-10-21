import { ArrowsLeftRightIcon, WarningIcon } from '@phosphor-icons/react'
import type { ViewerOpenResult, ViewerStopReason } from '@shared/files/filesApi'
import { useEffect, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { IconButton } from '@/components/common/IconButton'
import { Button } from '@/components/ui/button'
import { useDict } from '@/lib/app/useDict'
import type { ViewerOption } from '@/lib/files/viewerChoice'
import { useGuestReady, useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useInjectedCss, usePanelThemeCss } from '@/lib/theme/panelThemeInjection'
import { useOpenWithStore } from '@/stores/files/openWithStore'
import { ViewerMessage } from './ViewerChrome'

const ABORTED = -3

interface FrameProps {
  workspaceId: string
  paneId: string
  filePath: string
  viewer: ViewerOption
  onFailed: () => void
}

export function FileViewerFrame(props: FrameProps): JSX.Element {
  const [attempt, setAttempt] = useState(0)
  return <ViewerFrame key={attempt} {...props} onReload={() => setAttempt((n) => n + 1)} />
}

function ViewerFrame({
  workspaceId,
  paneId,
  filePath,
  viewer,
  onFailed,
  onReload,
}: FrameProps & { onReload: () => void }): JSX.Element {
  const d = useDict()
  const openWith = useOpenWithStore((s) => s.open)
  const themeCss = usePanelThemeCss()
  const [opened, setOpened] = useState<Extract<ViewerOpenResult, { ok: true }> | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const [stopped, setStopped] = useState<ViewerStopReason | 'crashed' | null>(null)
  const readyWebview = useGuestReady(webview)
  useSurfaceFocus(paneId, () => readyWebview)
  useInjectedCss(webview, themeCss)

  useEffect(
    () =>
      window.ostia.viewers.onStopped((event) => {
        if (event.paneId === paneId) setStopped(event.reason)
      }),
    [paneId],
  )

  useEffect(() => {
    let alive = true
    setOpened(null)
    window.ostia.viewers
      .open({ workspaceId, paneId, path: filePath, viewType: viewer.viewType })
      .then(
        (result) => {
          if (!alive) return
          if (result.ok) setOpened(result)
          else onFailed()
        },
        () => {
          if (alive) onFailed()
        },
      )
    return () => {
      alive = false
      window.ostia.viewers.close(paneId)
    }
  }, [workspaceId, paneId, filePath, viewer.viewType, onFailed])

  useEffect(() => {
    const el = webview
    if (!el) return
    const onFail = (e: Event): void => {
      const failed = e as unknown as { errorCode: number; isMainFrame: boolean }
      if (failed.isMainFrame && failed.errorCode !== ABORTED) onFailed()
    }
    const onGone = (): void => setStopped((reason) => reason ?? 'crashed')
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('render-process-gone', onGone)
    return () => {
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('render-process-gone', onGone)
    }
  }, [webview, onFailed])

  return (
    <div className="viewer-surface" data-testid="file-viewer" data-view-type={viewer.viewType}>
      <div className="viewer-toolbar">
        <span className="viewer-title">{filePath.slice(filePath.lastIndexOf('/') + 1)}</span>
        <span className="viewer-meta">{viewer.displayName}</span>
        <span className="flex-1" />
        <IconButton
          size="bar"
          icon={ArrowsLeftRightIcon}
          label={d.viewer.openWith}
          onClick={() => openWith(paneId)}
        />
      </div>
      <div className="viewer-body">
        {stopped ? (
          <EmptyState
            variant="surface"
            size="sm"
            className="flex-1"
            data-testid="viewer-stopped"
            icon={<WarningIcon aria-hidden />}
            title={d.viewer.stopped[stopped]}
            actions={
              <Button variant="outline" size="sm" onClick={onReload}>
                {d.viewer.reload}
              </Button>
            }
          />
        ) : opened ? (
          <webview
            ref={setWebview}
            className="extension-webview"
            src={opened.src}
            partition={opened.partition}
          />
        ) : (
          <ViewerMessage>{d.viewer.loading}</ViewerMessage>
        )}
      </div>
    </div>
  )
}
