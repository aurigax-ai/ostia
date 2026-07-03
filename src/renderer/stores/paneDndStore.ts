import { create } from 'zustand'
import type { DropZone } from '../layout/tree'

/**
 * Transient drag state for relocating panes: which pane is hovered and where the
 * dragged pane would land. Drives the drop-zone overlay; cleared on drop / drag-end.
 */
interface PaneDndState {
  overId: string | null
  zone: DropZone | null
  setOver: (overId: string, zone: DropZone) => void
  reset: () => void
}

export const usePaneDnd = create<PaneDndState>((set) => ({
  overId: null,
  zone: null,
  setOver: (overId, zone) => set({ overId, zone }),
  reset: () => set({ overId: null, zone: null }),
}))
