import { useDict } from '@/lib/app/useDict'
import { unscaledRegion } from '@/lib/browser/deviceFrame'
import { useGuestReady, useSurfaceFocus } from '@/lib/panes/paneFocus'
import { type BrowserDevice, DEFAULT_DEVICE } from '@shared/browser/browserDevice'
import { type BrowserProfile, browserPartition } from '@shared/browser/browserProfile'
import type { DeviceTouch } from '@shared/browser/deviceTouch'
import { useCallback, useRef, useState } from 'react'
import { BrowserCaptureBar } from './BrowserCaptureBar'
import { BrowserFind, type FindResult } from './BrowserFind'
import { BrowserLoadError } from './BrowserLoadError'
import { BrowserStoragePanel } from './BrowserStoragePanel'
import { BrowserToolbar } from './BrowserToolbar'
import { DeviceBar } from './DeviceBar'
import { DeviceStage } from './DeviceStage'
import { RegionCropOverlay } from './RegionCropOverlay'
import { useBrowserActions } from './useBrowserActions'
import { useBrowserCapture } from './useBrowserCapture'
import { useBrowserDevice } from './useBrowserDevice'
import { useBrowserNavigation } from './useBrowserNavigation'
import { useGrantedProfile } from './useGrantedProfile'
import { useWebviewEvents } from './useWebviewEvents'

export function BrowserView({
  workspaceId,
  paneId,
  url,
  profile,
  device: savedDevice,
}: {
  workspaceId: string
  paneId: string
  url?: string
  profile: BrowserProfile
  device?: BrowserDevice
}): JSX.Element {
  const d = useDict()
  const granted = useGrantedProfile({ workspaceId, paneId, profile })
  const partition = granted ? browserPartition(granted, paneId) : null
  const {
    webviewRef,
    lastAppliedUrlRef,
    readyRef,
    pendingUrlRef,
    staleSrcRef,
    address,
    setAddress,
    src,
    editingRef,
    showAddress,
    srcRef,
    canGoBack,
    setCanGoBack,
    canGoForward,
    setCanGoForward,
    loadError,
    setLoadError,
    navCount,
    setNavCount,
    addressRef,
    withGuest,
    load,
    navigate,
    onAddressKeyDown,
  } = useBrowserNavigation({ url })
  const [webview, setWebview] = useState<HTMLElement | null>(null)
  const readyWebview = useGuestReady(webview)
  const attachWebview = useCallback(
    (el: HTMLElement | null) => {
      webviewRef.current = el
      setWebview(el)
    },
    [webviewRef],
  )
  useSurfaceFocus(paneId, () => readyWebview)
  const sendTouch = useCallback(
    (input: DeviceTouch) => window.ostia.browser.deviceTouch(paneId, input),
    [paneId],
  )
  const focusPage = useCallback(() => webviewRef.current?.focus(), [webviewRef])
  const { device, preview, commit } = useBrowserDevice({
    workspaceId,
    paneId,
    saved: savedDevice,
    readyWebview,
  })
  const [storageOpen, setStorageOpen] = useState(false)
  const [findFocus, setFindFocus] = useState(-1)
  const [findResult, setFindResult] = useState<FindResult | null>(null)
  const findStepRef = useRef<((by: number) => void) | null>(null)

  useWebviewEvents({
    workspaceId,
    paneId,
    partition,
    webviewRef,
    readyRef,
    srcRef,
    staleSrcRef,
    pendingUrlRef,
    lastAppliedUrlRef,
    withGuest,
    load,
    showAddress,
    setCanGoBack,
    setCanGoForward,
    setNavCount,
    setLoadError,
    setFindResult,
  })

  const { searchPage, clearFind, closeFind, onSurfaceKeyDown } = useBrowserActions({
    paneId,
    webviewRef,
    readyRef,
    addressRef,
    findStepRef,
    withGuest,
    setFindFocus,
    setFindResult,
  })

  const {
    picking,
    capture,
    setCapture,
    cropping,
    setCropping,
    region,
    setRegion,
    sending,
    status,
    setStatus,
    targets,
    noTargets,
    startCrop,
    finishCrop,
    copyRegion,
    togglePick,
    send,
  } = useBrowserCapture({ workspaceId, paneId, partition, webviewRef, withGuest, d })

  return (
    <div className="browser-surface relative" onKeyDown={onSurfaceKeyDown}>
      <BrowserToolbar
        paneId={paneId}
        withGuest={withGuest}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        addressRef={addressRef}
        address={address}
        setAddress={setAddress}
        editingRef={editingRef}
        onAddressKeyDown={onAddressKeyDown}
        picking={picking}
        togglePick={togglePick}
        cropping={cropping}
        setCropping={setCropping}
        startCrop={startCrop}
        navCount={navCount}
        setStatus={setStatus}
        storageOpen={storageOpen}
        setStorageOpen={setStorageOpen}
        deviceOn={device !== undefined}
        toggleDevice={() => commit(device ? null : DEFAULT_DEVICE)}
      />
      {device ? <DeviceBar device={device} onChange={commit} /> : null}
      <BrowserCaptureBar
        picking={picking}
        cropping={cropping}
        status={status}
        capture={capture}
        setCapture={setCapture}
        region={region}
        setRegion={setRegion}
        targets={targets}
        noTargets={noTargets}
        sending={sending}
        send={send}
        copyRegion={copyRegion}
      />
      <div className="browser-stage">
        <DeviceStage
          device={device}
          onPreview={preview}
          onCommit={commit}
          onTouch={sendTouch}
          onFocusPage={focusPage}
          overlay={(scale) =>
            cropping ? (
              <RegionCropOverlay
                label={d.browser.regionLayer}
                onDone={(rect, view) => {
                  const unscaled = unscaledRegion(rect, view, scale)
                  void finishCrop(unscaled.rect, unscaled.view)
                }}
                onCancel={() => setCropping(false)}
              />
            ) : null
          }
        >
          {partition ? (
            <webview
              key={partition}
              ref={attachWebview}
              className="browser-webview"
              src={src}
              partition={partition}
            />
          ) : null}
        </DeviceStage>
        {findFocus >= 0 ? (
          <BrowserFind
            focusKey={findFocus}
            result={findResult}
            onSearch={searchPage}
            onClear={clearFind}
            onClose={closeFind}
            stepRef={findStepRef}
          />
        ) : null}
        {loadError ? <BrowserLoadError loadError={loadError} navigate={navigate} /> : null}
      </div>
      {storageOpen ? (
        <BrowserStoragePanel
          paneId={paneId}
          shared={granted === 'shared'}
          refreshKey={navCount}
          onClose={() => setStorageOpen(false)}
        />
      ) : null}
    </div>
  )
}
