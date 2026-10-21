import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import type { ClipboardCapture } from '../keyboard/clipboardCapture'
import type { ClipboardChords, ClipboardEdit } from '../keyboard/clipboardChords'
import type { GuestChordFire } from '../keyboard/guestChords'
import type { ModifierRemap } from '../keyboard/modifierRemap'
import type { AppMenuSpec } from './appMenu'
import type { BuildInfo } from './buildInfo'
import type { DiscreteGpuInfo } from './discreteGpu'
import type {
  ReleaseState,
  ReplaceProgress,
  ReplaceStart,
  ReplaceState,
  UpdateRunStart,
  UpdateRunState,
} from './installMethod'
import type { ReleaseCheckResult } from './releases'
import type { RequirementsReport } from './systemRequirements'

export const RENDERER_ERROR_KINDS = ['error', 'rejection', 'render', 'surface'] as const

export type RendererErrorKind = (typeof RENDERER_ERROR_KINDS)[number]

export interface RendererErrorReport {
  kind: RendererErrorKind
  message: string
  stack?: string
  source?: string
}

interface DiagnosticsApi {
  report: (report: RendererErrorReport) => void
  ready: (paneIds: string[]) => void
  reloadWindow: () => void
  toggleDevTools: () => void
  openLogFolder: () => Promise<boolean>
  testHooks: () => Promise<boolean>
  onTestCrash: (handler: () => void) => () => void
}

interface SystemApi {
  requirements: (feature: string) => Promise<RequirementsReport | null>
  installRequirements: (feature: string, workspaceId: string) => Promise<ExtensionResult>
  discreteGpu: () => Promise<DiscreteGpuInfo | null>
  softwareWebgl: boolean
}

interface SettingsApi {
  path: () => Promise<string>
  onChanged: (cb: () => void) => () => void
}

interface AppMenuApi {
  set: (spec: AppMenuSpec) => void
  onRun: (cb: (command: string) => void) => () => void
}

export interface ClipboardContents {
  files: string[]
  image: boolean
}

interface ClipboardApi {
  edit: (edit: ClipboardEdit) => Promise<void>
  contents: () => Promise<ClipboardContents>
  setChords: (chords: ClipboardChords) => void
  writeCapture: (capture: ClipboardCapture) => Promise<boolean>
}

interface GuestChordsApi {
  set: (signatures: string[]) => void
  setRemap: (table: ModifierRemap) => void
  onFire: (cb: (fire: GuestChordFire) => void) => () => void
}

interface AppUpdateApi {
  state: () => Promise<BuildInfo | null>
  restart: () => Promise<void>
  onAvailable: (cb: (info: BuildInfo) => void) => () => void
  release: () => Promise<ReleaseState>
  checkRelease: () => Promise<ReleaseCheckResult>
  openRelease: () => Promise<boolean>
  dismissRelease: () => Promise<void>
  onRelease: (cb: (state: ReleaseState) => void) => () => void
  runUpdate: () => Promise<UpdateRunStart>
  updateRun: () => Promise<UpdateRunState>
  onUpdateRun: (cb: (state: UpdateRunState) => void) => () => void
  replaceInstall: () => Promise<ReplaceStart>
  replaceState: () => Promise<ReplaceState>
  onReplace: (cb: (state: ReplaceState) => void) => () => void
  onProgress: (cb: (progress: ReplaceProgress) => void) => () => void
}

export interface ExternalEditorRequest {
  template: string
  file: string
  line?: number
  column?: number
}

export type ExternalEditorResult =
  | { ok: true; argv: string[] }
  | {
      ok: false
      error: 'invalid-path' | 'no-editor' | 'invalid-template' | 'spawn-failed'
      message?: string
    }

interface ExternalEditorApi {
  open: (req: ExternalEditorRequest) => Promise<ExternalEditorResult>
}

export interface AppBridge {
  diagnostics: DiagnosticsApi
  settings: SettingsApi
  appMenu: AppMenuApi
  system: SystemApi
  update: AppUpdateApi
  clipboard: ClipboardApi
  guestChords: GuestChordsApi
  externalEditor: ExternalEditorApi
}
