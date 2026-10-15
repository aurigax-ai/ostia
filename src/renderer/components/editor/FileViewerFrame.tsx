import { IconButton } from '@/components/common/IconButton'
import { useDict } from '@/lib/app/useDict'
import type { ViewerOption } from '@/lib/files/viewerChoice'
import { useGuestReady, useSurfaceFocus } from '@/lib/panes/paneFocus'
import { useInjectedCss, usePanelThemeCss } from '@/lib/theme/panelThemeInjection'
import { useOpenWithStore } from '@/stores/files/openWithStore'
import { ArrowsLeftRightIcon } from '@phosphor-icons/react'
import type { ViewerOpenResult } from '@shared/types'
import { useEffect, useState } from 'react'
import { ViewerMessage } from './ViewerChrome'

const ABORTED = -3

export function FileViewerFrame({
  workspaceId,
  paneId,
  filePath,
  viewer,
  onFailed,
}: {
  workspaceId: string
  paneId: string
  filePath: string
  viewer: ViewerOption
  onFailed: () => void
}): JSX.Element {
  const d = useDict()
  const openWith = useOpenWithStore((s) => s.open)
  const themeCss = usePanelThemeCss()
  const [opened, setOpened] = useState<Extract<ViewerOpenResult, { ok: true }> | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const readyWebview = useGuestReady(webview)
  useSurfaceFocus(paneId, () => readyWebview)
  useInjectedCss(webview, themeCss)

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
    el.addEventListener('did-fail-load', onFail)
    el.addEventListener('render-process-gone', onFailed)
    return () => {
      el.removeEventListener('did-fail-load', onFail)
      el.removeEventListener('render-process-gone', onFailed)
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
        {opened ? (
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
