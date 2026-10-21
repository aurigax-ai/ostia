import { OWN_VIEW } from '@aurigax-ai/ostia-extension-sdk/contract/fileKinds'
import { WarningIcon } from '@phosphor-icons/react'
import { selectionLabel } from '@shared/browser/selection'
import type {
  ViewerOpenResult,
  ViewerSelectionEvent,
  ViewerStopReason,
} from '@shared/files/filesApi'
import { useEffect, useRef, useState } from 'react'
import { RegionActionBar } from '@/components/agents/RegionActionBar'
import { EmptyState } from '@/components/common/EmptyState'
import { StatusLine } from '@/components/common/StatusLine'
import { Button } from '@/components/ui/button'
import type { PickTarget } from '@/lib/agents/pickTargets'
import { registerSelectionCopier } from '@/lib/agents/selectionCopiers'
import { registerSelectionSender } from '@/lib/agents/selectionSenders'
import { sendViewerSelectionToPane } from '@/lib/agents/sendPick'
import { fmt, useDict } from '@/lib/app/useDict'
import { useTransientStatus } from '@/lib/app/useTransientStatus'
import { usePaneVisible } from '@/lib/attention/workspaceActivity'
import { openBrowserTabAs } from '@/lib/browser/browserProfile'
import type { ViewerOption } from '@/lib/files/viewerChoice'
import { useGuestReady, useSurfaceFocus } from '@/lib/panes/paneFocus'
import { webLinkTarget } from '@/lib/terminalLinks/linkModifier'
import { useInjectedCss, usePanelThemeCss } from '@/lib/theme/panelThemeInjection'
import { isMac } from '@/platform'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useViewerHintStore } from '@/stores/files/viewerHintStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useLiveDocumentText } from './useLiveDocumentText'
import { ViewerMessage } from './ViewerChrome'

const ABORTED = -3
const SEND_STATUS_MS = 6000

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
  const themeCss = usePanelThemeCss()
  const linkClick = useSettingsStore((s) => s.terminal.linkClick)
  const [opened, setOpened] = useState<Extract<ViewerOpenResult, { ok: true }> | null>(null)
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const [stopped, setStopped] = useState<ViewerStopReason | 'crashed' | null>(null)
  const readyWebview = useGuestReady(webview)
  useSurfaceFocus(paneId, () => readyWebview)
  useInjectedCss(webview, themeCss)
  const visible = usePaneVisible(paneId)
  const webviewRef = useRef<HTMLElement | null>(null)
  webviewRef.current = webview
  const [shown, setShown] = useState<{
    selection: NonNullable<ViewerSelectionEvent['selection']>
    takeFocus: boolean
  } | null>(null)
  const [sendRequest, setSendRequest] = useState(0)
  const [status, setStatus] = useTransientStatus(SEND_STATUS_MS)
  const [hint, setHint] = useState<{ value: string; count: number } | null>(() => {
    const value = useViewerHintStore.getState().take(filePath)
    return value === undefined ? null : { value, count: 0 }
  })
  useLiveDocumentText(paneId, filePath, opened !== null)
  const selection = shown?.selection ?? null

  useEffect(
    () =>
      useViewerHintStore.subscribe((state) => {
        if (state.pending[filePath] === undefined) return
        const next = useViewerHintStore.getState().take(filePath)
        if (next !== undefined) {
          setHint((current) => ({ value: next, count: (current?.count ?? 0) + 1 }))
        }
      }),
    [filePath],
  )

  useEffect(
    () =>
      window.ostia.viewers.onSelection((event) => {
        if (event.paneId !== paneId) return
        setShown((current) =>
          event.selection
            ? {
                selection: event.selection,
                takeFocus:
                  current?.selection.seq === event.selection.seq
                    ? current.takeFocus
                    : document.activeElement === webviewRef.current,
              }
            : null,
        )
      }),
    [paneId],
  )

  useEffect(() => {
    if (!selection) return
    return registerSelectionSender(paneId, () => setSendRequest((n) => n + 1))
  }, [paneId, selection])

  useEffect(() => {
    if (!selection) return
    return registerSelectionCopier(paneId, () =>
      window.ostia.viewers.copySelection(paneId).then(() => undefined),
    )
  }, [paneId, selection])

  useEffect(
    () =>
      window.ostia.viewers.onOpenLink((event) => {
        if (event.paneId !== paneId) return
        const { target } = event
        if (target.kind === 'file') {
          useLayoutStore.getState().openFile(workspaceId, target.path)
          return
        }
        const click = {
          ctrlKey: !isMac,
          metaKey: isMac,
          shiftKey: target.shift,
          detail: 1,
        }
        const where = webLinkTarget(click, {
          mac: isMac,
          hasSelection: false,
          mouseReporting: false,
          linkClick,
        })
        if (target.href.startsWith('mailto:') || where === 'system') {
          void window.ostia.openPath.openLink(target.href)
        } else openBrowserTabAs(workspaceId, target.href, 'human')
      }),
    [paneId, workspaceId, linkClick],
  )

  useEffect(
    () =>
      window.ostia.viewers.onEditSource((event) => {
        if (event.paneId === paneId) {
          useLayoutStore.getState().setViewType(workspaceId, paneId, OWN_VIEW)
        }
      }),
    [paneId, workspaceId],
  )

  const sendSelection = async (target: PickTarget, note: string): Promise<void> => {
    if (!selection) return
    const res = await sendViewerSelectionToPane({
      paneId,
      targetPaneId: target.paneId,
      via: target.via,
      note,
      label: selectionLabel(selection.capture),
    })
    if (!res.ok) throw new Error(fmt(d.send.sendFailed, { reason: res.error }))
    setStatus(fmt(res.inserted ? d.send.sentInserted : d.send.sentCopied, { pane: target.title }))
  }

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
            src={hint ? `${opened.src}#${hint.value}&n=${hint.count}` : opened.src}
            partition={opened.partition}
          />
        ) : (
          <ViewerMessage>{d.viewer.loading}</ViewerMessage>
        )}
      </div>
      {status ? (
        <div className="absolute inset-x-0 top-0 z-20">
          <StatusLine onDismiss={() => setStatus(null)}>{status}</StatusLine>
        </div>
      ) : null}
      {selection && visible ? (
        <RegionActionBar
          key={selection.seq}
          workspaceId={workspaceId}
          anchor={selection.anchor}
          takeFocus={shown?.takeFocus ?? false}
          sendRequest={sendRequest}
          onCopy={() => window.ostia.viewers.copySelection(paneId)}
          onSend={sendSelection}
          onClose={() => window.ostia.viewers.clearSelection(paneId)}
        />
      ) : null}
    </div>
  )
}
