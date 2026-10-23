import {
  ArrowClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  CropIcon,
  CursorClickIcon,
  DatabaseIcon,
  DeviceMobileIcon,
} from '@phosphor-icons/react'
import type { WebviewTag } from 'electron'
import type { Dispatch, KeyboardEvent, MutableRefObject, SetStateAction } from 'react'
import { IconButton } from '@/components/common/IconButton'
import { Input } from '@/components/ui/input'
import { useDict } from '@/lib/app/useDict'
import { setCaptureStatus } from '@/lib/capture/captureSession'
import { LoginButton } from './LoginButton'

interface BrowserToolbarProps {
  paneId: string
  withGuest: (fn: (wv: WebviewTag) => void) => boolean
  canGoBack: boolean
  canGoForward: boolean
  addressRef: MutableRefObject<HTMLInputElement | null>
  address: string
  setAddress: (next: string) => void
  editingRef: MutableRefObject<boolean>
  onAddressKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
  picking: { byAgent: boolean } | null
  togglePick: () => Promise<void>
  cropping: boolean
  setCropping: (next: boolean) => void
  startCrop: () => void
  navCount: number
  storageOpen: boolean
  setStorageOpen: Dispatch<SetStateAction<boolean>>
  deviceOn: boolean
  toggleDevice: () => void
}

export function BrowserToolbar({
  paneId,
  withGuest,
  canGoBack,
  canGoForward,
  addressRef,
  address,
  setAddress,
  editingRef,
  onAddressKeyDown,
  picking,
  togglePick,
  cropping,
  setCropping,
  startCrop,
  navCount,
  storageOpen,
  setStorageOpen,
  deviceOn,
  toggleDevice,
}: BrowserToolbarProps): JSX.Element {
  const d = useDict()
  return (
    <div className="browser-toolbar">
      <IconButton
        icon={ArrowLeftIcon}
        label={d.browser.back}
        command="browser.back"
        disabled={!canGoBack}
        onClick={() => withGuest((wv) => wv.goBack())}
      />
      <IconButton
        icon={ArrowRightIcon}
        label={d.browser.forward}
        command="browser.forward"
        disabled={!canGoForward}
        onClick={() => withGuest((wv) => wv.goForward())}
      />
      <IconButton
        icon={ArrowClockwiseIcon}
        label={d.browser.reload}
        command="browser.reload"
        onClick={() => withGuest((wv) => wv.reload())}
      />
      <Input
        ref={addressRef}
        className="browser-address h-6 flex-1 font-mono text-ui-sm md:text-ui-sm"
        aria-label={d.browser.address}
        placeholder={d.browser.addressPlaceholder}
        value={address}
        spellCheck={false}
        onChange={(e) => {
          editingRef.current = true
          setAddress(e.target.value)
        }}
        onBlur={() => {
          editingRef.current = false
        }}
        onKeyDown={onAddressKeyDown}
      />
      <IconButton
        icon={DeviceMobileIcon}
        label={deviceOn ? d.browser.deviceStop : d.browser.device}
        aria-pressed={deviceOn}
        onClick={toggleDevice}
      />
      <IconButton
        icon={CursorClickIcon}
        label={picking ? d.browser.pickStop : d.browser.pick}
        aria-pressed={picking !== null}
        onClick={() => void togglePick()}
      />
      <IconButton
        icon={CropIcon}
        label={cropping ? d.browser.regionStop : d.browser.region}
        aria-pressed={cropping}
        onClick={() => (cropping ? setCropping(false) : startCrop())}
      />
      <LoginButton
        paneId={paneId}
        pageKey={navCount}
        onStatus={(text) => setCaptureStatus(paneId, text)}
      />
      <IconButton
        icon={DatabaseIcon}
        label={storageOpen ? d.browser.storageHide : d.browser.storageShow}
        aria-pressed={storageOpen}
        onClick={() => setStorageOpen((open) => !open)}
      />
    </div>
  )
}
