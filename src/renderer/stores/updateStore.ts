import { type BuildInfo, buildLabel, sameBuild } from '@shared/buildInfo'
import { PRODUCT_NAME } from '@shared/product'
import type { ReleaseCheckResult, ReleaseInfo } from '@shared/releases'
import { create } from 'zustand'
import { currentDict, fmt } from '../i18n/useDict'

export type ReleaseCheckState = { status: 'idle' } | { status: 'checking' } | ReleaseCheckResult

interface UpdateState {
  available: BuildInfo | null
  dismissed: BuildInfo | null
  release: ReleaseInfo | null
  releaseCheck: ReleaseCheckState
  receive: (info: BuildInfo | null) => void
  dismiss: () => void
  receiveRelease: (release: ReleaseInfo | null) => void
  dismissRelease: () => void
  checkForUpdates: () => Promise<void>
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  available: null,
  dismissed: null,
  release: null,
  releaseCheck: { status: 'idle' },
  receive: (info) => {
    const before = get().available
    set({ available: info })
    if (info && (!before || !sameBuild(before, info)) && !document.hasFocus()) notify(info)
  },
  dismiss: () => set((s) => ({ dismissed: s.available })),
  receiveRelease: (release) => set({ release }),
  dismissRelease: () => {
    set({ release: null })
    void window.pine.update.dismissRelease()
  },
  checkForUpdates: async () => {
    if (get().releaseCheck.status === 'checking') return
    set({ releaseCheck: { status: 'checking' } })
    const releaseCheck = await window.pine.update
      .checkRelease()
      .catch((): ReleaseCheckResult => ({ status: 'error', error: 'unavailable' }))
    set({ releaseCheck })
  },
}))

export function showsUpdate(s: Pick<UpdateState, 'available' | 'dismissed'>): boolean {
  return Boolean(s.available && !(s.dismissed && sameBuild(s.available, s.dismissed)))
}

function notify(info: BuildInfo): void {
  if (typeof Notification === 'undefined') return
  const d = currentDict()
  const note = new Notification(fmt(d.update.title, { product: PRODUCT_NAME }), {
    body: fmt(d.update.body, { build: buildLabel(info) }),
  })
  note.onclick = () => window.focus()
}

export function startUpdateWatch(): () => void {
  const { receive, receiveRelease } = useUpdateStore.getState()
  void window.pine.update.state().then(receive)
  void window.pine.update.release().then(receiveRelease)
  const stopBuilds = window.pine.update.onAvailable(receive)
  const stopReleases = window.pine.update.onRelease(receiveRelease)
  return () => {
    stopBuilds()
    stopReleases()
  }
}
