import { currentDict, fmt } from '@/i18n/useDict'
import { startNewWorkspace } from '@/lib/workspaces/newWorkspace'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { type BuildInfo, sameBuild } from '@shared/app/buildInfo'
import {
  type InstallMethod,
  type ReleaseState,
  type ReplaceAvailability,
  type ReplaceProgress,
  type ReplaceState,
  type UpdateRunState,
  managedUpdateMethod,
} from '@shared/app/installMethod'
import type { ReleaseCheckResult, ReleaseInfo } from '@shared/app/releases'
import { create } from 'zustand'

export type ReleaseCheckState = { status: 'idle' } | { status: 'checking' } | ReleaseCheckResult

interface UpdateState {
  available: BuildInfo | null
  dismissed: BuildInfo | null
  release: ReleaseInfo | null
  method: InstallMethod
  updateCommand: string | null
  updateRun: UpdateRunState
  replace: ReplaceAvailability | null
  replaceRun: ReplaceState
  progress: ReplaceProgress | null
  confirming: boolean
  releaseCheck: ReleaseCheckState
  receive: (info: BuildInfo | null) => void
  dismiss: () => void
  receiveRelease: (state: ReleaseState) => void
  receiveUpdateRun: (state: UpdateRunState) => void
  receiveReplace: (state: ReplaceState) => void
  receiveProgress: (progress: ReplaceProgress) => void
  replaceInstall: () => Promise<void>
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
  replace: null,
  replaceRun: { status: 'idle' },
  progress: null,
  confirming: false,
  releaseCheck: { status: 'idle' },
  receive: (info) => {
    const before = get().available
    set({ available: info })
    if (info && (!before || !sameBuild(before, info)) && !document.hasFocus()) notify(info)
  },
  dismiss: () => set((s) => ({ dismissed: s.available })),
  receiveRelease: ({ release, method, updateCommand, replace }) =>
    set({ release, method, updateCommand, replace }),
  receiveUpdateRun: (updateRun) => set({ updateRun }),
  receiveReplace: (replaceRun) =>
    set(replaceRun.status === 'downloading' ? { replaceRun } : { replaceRun, progress: null }),
  receiveProgress: (progress) => set({ progress }),
  replaceInstall: async () => {
    const start = await window.ostia.update.replaceInstall()
    if (start === 'started' && get().replaceRun.status !== 'done') {
      set({ replaceRun: { status: 'downloading' }, progress: null })
    }
  },
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
  s: Pick<UpdateState, 'release' | 'method' | 'replace'>,
): 'apt' | 'brew' | 'replace' | 'release' | null {
  if (!s.release) return null
  if (s.replace?.ok) return 'replace'
  return managedUpdateMethod(s.method) ?? 'release'
}

export function restartReady(s: Pick<UpdateState, 'updateRun' | 'replaceRun'>): boolean {
  return s.updateRun.status === 'done' || s.replaceRun.status === 'done'
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
  const { receive, receiveRelease, receiveUpdateRun, receiveReplace, receiveProgress } =
    useUpdateStore.getState()
  void window.ostia.update.state().then(receive)
  void window.ostia.update.release().then(receiveRelease)
  void window.ostia.update.updateRun().then(receiveUpdateRun)
  void window.ostia.update.replaceState().then(receiveReplace)
  const stops = [
    window.ostia.update.onAvailable(receive),
    window.ostia.update.onRelease(receiveRelease),
    window.ostia.update.onUpdateRun(receiveUpdateRun),
    window.ostia.update.onReplace(receiveReplace),
    window.ostia.update.onProgress(receiveProgress),
  ]
  return () => {
    for (const stop of stops) stop()
  }
}
