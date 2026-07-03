import { create } from 'zustand'

/**
 * DOM slots that pooled surfaces (terminals/editors) portal their content into. The
 * surfaces are mounted ONCE in <SurfacePool> and portaled into the current slot for their
 * pane id — so a layout change (split / drag-relocate) that remounts the pane's slot only
 * RE-PARENTS the surface's DOM. The xterm/Monaco instance and its pty never remount, which
 * is what stops the split-triggered replay + prompt "staircase" (the cmux mount-once rule).
 */
interface SurfaceSlotsState {
  slots: Record<string, HTMLElement | null>
  setSlot: (paneId: string, el: HTMLElement | null) => void
}

export const useSurfaceSlots = create<SurfaceSlotsState>((set) => ({
  slots: {},
  setSlot: (paneId, el) =>
    set((s) => {
      if (s.slots[paneId] === el) return s
      return { slots: { ...s.slots, [paneId]: el } }
    }),
}))
