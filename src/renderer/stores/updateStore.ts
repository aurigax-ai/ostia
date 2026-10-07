import { type BuildInfo, sameBuild } from '@shared/buildInfo'
import {
  type InstallMethod,
  type ReleaseState,
  type UpdateRunState,
  managedUpdateMethod,
} from '@shared/installMethod'
import type { ReleaseCheckResult, ReleaseInfo } from '@shared/releases'
import { create } from 'zustand'
import { currentDict, fmt } from '../i18n/useDict'
import { startNewWorkspace } from '../lib/newWorkspace'
import { useWorkspacesStore } from './workspacesStore'

export type ReleaseCheckState = { status: 'idle' } | { status: 'checking' } | ReleaseCheckResult

interface UpdateState {
  available: BuildInfo | null
  dismissed: BuildInfo | null
  release: ReleaseInfo | null
  method: InstallMethod
  updateCommand: string | null
  updateRun: UpdateRunState
  confirming: boolean
  releaseCheck: ReleaseCheckState
  receive: (info: BuildInfo | null) => void
  dismiss: () => void
  receiveRelease: (state: ReleaseState) => void
  receiveUpdateRun: (state: UpdateRunState) => void
  dismissRelease: () => void
  checkForUpdates: () => Promise<void>
  askUpdate: () => void
  cancelUpdate: () => void
  confirmUpdate: () => Promise<void>
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  available: null,
  dismissed: null,
  release: null,
  method: 'dev',
  updateCommand: null,
  updateRun: { status: 'idle' },
  confirming: false,
  releaseCheck: { status: 'idle' },
  receive: (info) => {
    const before = get().available
    set({ available: info })
    if (info && (!before || !sameBuild(before, info)) && !document.hasFocus()) notify(info)
  },
  dismiss: () => set((s) => ({ dismissed: s.available })),
  receiveRelease: ({ release, method, updateCommand }) => set({ release, method, updateCommand }),
  receiveUpdateRun: (updateRun) => set({ updateRun }),
  dismissRelease: () => {
    set({ release: null })
    void window.ostia.update.dismissRelease()
  },
  checkForUpdates: async () => {
    if (get().releaseCheck.status === 'checking') return
    set({ releaseCheck: { status: 'checking' } })
    const releaseCheck = await window.ostia.update
      .checkRelease()
      .catch((): ReleaseCheckResult => ({ status: 'error', error: 'unavailable' }))
    set({ releaseCheck })
  },
  askUpdate: () => {
    if (get().updateCommand) set({ confirming: true })
  },
  cancelUpdate: () => set({ confirming: false }),
  confirmUpdate: async () => {
    set({ confirming: false })
    if (!useWorkspacesStore.getState().activeWorkspaceId) startNewWorkspace()
    const start = await window.ostia.update.runUpdate()
    if (start === 'opened') set({ updateRun: { status: 'running' } })
  },
}))

export function showsUpdate(s: Pick<UpdateState, 'available' | 'dismissed'>): boolean {
  return Boolean(s.available && !(s.dismissed && sameBuild(s.available, s.dismissed)))
}

export function updateAction(
  s: Pick<UpdateState, 'release' | 'method'>,
): 'apt' | 'brew' | 'release' | null {
  if (!s.release) return null
  return managedUpdateMethod(s.method) ?? 'release'
}

function notify(info: BuildInfo): void {
  if (typeof Notification === 'undefined') return
  const d = currentDict()
  const note = new Notification(d.update.title, {
    body: fmt(d.update.body, { build: info.version }),
  })
  note.onclick = () => window.focus()
}

export function startUpdateWatch(): () => void {
  const { receive, receiveRelease, receiveUpdateRun } = useUpdateStore.getState()
  void window.ostia.update.state().then(receive)
  void window.ostia.update.release().then(receiveRelease)
  void window.ostia.update.updateRun().then(receiveUpdateRun)
  const stopBuilds = window.ostia.update.onAvailable(receive)
  const stopReleases = window.ostia.update.onRelease(receiveRelease)
  const stopRuns = window.ostia.update.onUpdateRun(receiveUpdateRun)
  return () => {
    stopBuilds()
    stopReleases()
    stopRuns()
  }
}
