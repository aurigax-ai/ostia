import { type BuildInfo, buildLabel, sameBuild } from '@shared/buildInfo'
import { PRODUCT_NAME } from '@shared/product'
import { create } from 'zustand'
import { currentDict, fmt } from '../i18n/useDict'

interface UpdateState {
  available: BuildInfo | null
  dismissed: BuildInfo | null
  receive: (info: BuildInfo | null) => void
  dismiss: () => void
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  available: null,
  dismissed: null,
  receive: (info) => {
    const before = get().available
    set({ available: info })
    if (info && (!before || !sameBuild(before, info)) && !document.hasFocus()) notify(info)
  },
  dismiss: () => set((s) => ({ dismissed: s.available })),
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
  const receive = useUpdateStore.getState().receive
  void window.pine.update.state().then(receive)
  return window.pine.update.onAvailable(receive)
}
