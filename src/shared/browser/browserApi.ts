import type { BrowserDevice } from './browserDevice'
import type { BrowserProfile } from './browserProfile'
import type {
  BrowserStorageRead,
  StorageEdit,
  StorageKind,
  StorageRemoval,
  StorageWriteResult,
} from './browserStorage'
import type {
  CredentialImportResult,
  CredentialInput,
  CredentialSaveResult,
  CredentialSummary,
} from './credentials'
import type { DeviceTouch } from './deviceTouch'
import type { BrowserTabOpen } from './linkTabs'
import type {
  PickCopyResult,
  PickOutcome,
  PickSendRequest,
  PickSendResult,
  PickState,
  PickTheme,
} from './pick'
import type {
  RegionCaptureOutcome,
  RegionCaptureRequest,
  RegionCopyResult,
  RegionSendRequest,
} from './regionCapture'
import type { PageSelection, SelectionSendRequest, SelectionSendResult } from './selection'

interface BrowserApi {
  claimProfile: (paneId: string, profile: BrowserProfile) => Promise<BrowserProfile>
  register: (paneId: string, webContentsId: number) => void
  unregister: (paneId: string) => void
  pickStart: (paneId: string, theme: PickTheme) => Promise<PickOutcome>
  pickCancel: (paneId: string) => void
  pickSend: (req: PickSendRequest) => Promise<PickSendResult>
  pickCopy: (paneId: string, captureId: string) => Promise<PickCopyResult>
  pageSelection: (paneId: string) => Promise<PageSelection | null>
  onPickState: (cb: (state: PickState) => void) => () => void
  regionCapture: (paneId: string, req: RegionCaptureRequest) => Promise<RegionCaptureOutcome>
  regionSend: (req: RegionSendRequest) => Promise<PickSendResult>
  regionCopy: (paneId: string, captureId: string) => Promise<RegionCopyResult>
  setDevice: (paneId: string, device: BrowserDevice | null) => Promise<boolean>
  deviceTouch: (paneId: string, input: DeviceTouch) => void
  storageRead: (paneId: string) => Promise<BrowserStorageRead>
  storageSet: (paneId: string, edit: StorageEdit) => Promise<StorageWriteResult>
  storageRemove: (paneId: string, removal: StorageRemoval) => Promise<StorageWriteResult>
  storageClear: (paneId: string, kind: StorageKind) => Promise<StorageWriteResult>
  onOpenTab: (cb: (open: BrowserTabOpen) => void) => () => void
}

interface SelectionApi {
  send: (req: SelectionSendRequest) => Promise<SelectionSendResult>
}

type CredentialFillResult =
  | { ok: true; username: string }
  | { ok: false; error: 'no-login' | 'no-form' | 'origin-changed' | 'locked' }

interface CredentialsApi {
  forPage: (paneId: string) => Promise<CredentialSummary[]>
  fill: (paneId: string, id: string) => Promise<CredentialFillResult>
  saveFromPage: (paneId: string) => Promise<CredentialSaveResult>
  list: () => Promise<CredentialSummary[]>
  save: (input: CredentialInput) => Promise<CredentialSaveResult>
  remove: (id: string) => Promise<boolean>
  copyPassword: (id: string) => Promise<boolean>
  import: () => Promise<CredentialImportResult>
}

export interface BrowserBridge {
  browser: BrowserApi
  selection: SelectionApi
  credentials: CredentialsApi
}
