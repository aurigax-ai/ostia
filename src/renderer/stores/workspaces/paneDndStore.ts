import type { DropZone } from '@/layout/tree'
import type { TabDrop } from '@/lib/panes/dropZone'
import { create } from 'zustand'

interface PaneDndState {
  dragging: boolean
  sourceId: string | null
  overId: string | null
  zone: DropZone | null
  tab: TabDrop | null
  droppedHere: boolean
  start: (sourceId: string | null) => void
  setOver: (overId: string, zone: DropZone, tab?: TabDrop | null) => void
  leave: (overId: string) => void
  dropped: () => void
  release: () => void
  reset: () => void
}

const IDLE = {
  dragging: false,
  sourceId: null,
  overId: null,
  zone: null,
  tab: null,
  droppedHere: false,
}

export const usePaneDnd = create<PaneDndState>((set, get) => ({
  ...IDLE,
  start: (sourceId) => set({ ...IDLE, dragging: true, sourceId }),
  setOver: (overId, zone, tab = null) => {
    const s = get()
    if (
      s.overId === overId &&
      s.zone === zone &&
      s.tab?.targetId === tab?.targetId &&
      s.tab?.after === tab?.after
    ) {
      return
    }
    set({ overId, zone, tab })
  },
  leave: (overId) => {
    if (get().overId === overId) set({ overId: null, zone: null, tab: null })
  },
  dropped: () => set({ overId: null, zone: null, tab: null, droppedHere: true }),
  release: () => {
    if (get().dragging) set({ dragging: false, overId: null, zone: null, tab: null })
  },
  reset: () => set(IDLE),
}))
