import { useDict } from '@/lib/app/useDict'
import { useSurfaceFocus } from '@/lib/panes/paneFocus'
import { type BrowserProfile, browserPartition } from '@shared/browser/browserProfile'
import { useRef, useState } from 'react'
import { BrowserCaptureBar } from './BrowserCaptureBar'
import { BrowserFind, type FindResult } from './BrowserFind'
import { BrowserLoadError } from './BrowserLoadError'
import { BrowserStoragePanel } from './BrowserStoragePanel'
import { BrowserToolbar } from './BrowserToolbar'
import { RegionCropOverlay } from './RegionCropOverlay'
import { useBrowserActions } from './useBrowserActions'
import { useBrowserCapture } from './useBrowserCapture'
import { useBrowserNavigation } from './useBrowserNavigation'
import { useGrantedProfile } from './useGrantedProfile'
import { useWebviewEvents } from './useWebviewEvents'

export function BrowserView({
  workspaceId,
  paneId,
  url,
  profile,
}: {
  workspaceId: string
  paneId: string
  url?: string
  profile: BrowserProfile
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
  useSurfaceFocus(paneId, () => webviewRef.current)
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
      />
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
        {partition ? (
          <webview
            key={partition}
            ref={(el) => {
              webviewRef.current = el
            }}
            className="browser-webview"
            src={src}
            partition={partition}
          />
        ) : null}
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
        {cropping ? (
          <RegionCropOverlay
            label={d.browser.regionLayer}
            onDone={(rect, view) => void finishCrop(rect, view)}
            onCancel={() => setCropping(false)}
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
