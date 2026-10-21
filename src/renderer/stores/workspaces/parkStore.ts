import type { ParkRefusal, ResumeFailReason } from '@shared/park/park'
import { create } from 'zustand'

const PARK_NOTICE_MS = 15_000

type ParkNotice =
  | { kind: 'parked'; workspaceId: string; title: string; seq: number }
  | {
      kind: 'resumeFailed'
      workspaceId: string
      paneId: string
      title: string
      reason: ResumeFailReason
      seq: number
    }
  | {
      kind: 'refused'
      workspaceId: string
      paneId: string
      title: string
      reason: ParkRefusal
      seq: number
    }

type NoticeInput =
  | { kind: 'parked'; workspaceId: string; title: string }
  | {
      kind: 'resumeFailed'
      workspaceId: string
      paneId: string
      title: string
      reason: ResumeFailReason
    }
  | { kind: 'refused'; workspaceId: string; paneId: string; title: string; reason: ParkRefusal }

interface ParkState {
  notice: ParkNotice | null
  showNotice: (notice: NoticeInput) => void
  dismissNotice: () => void
}

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

export const useParkStore = create<ParkState>((set, get) => ({
  notice: null,
  showNotice: (notice) => {
    const next = { ...notice, seq: ++seq } as ParkNotice
    if (timer) clearTimeout(timer)
    set({ notice: next })
    timer = setTimeout(() => {
      if (get().notice?.seq === next.seq) set({ notice: null })
    }, PARK_NOTICE_MS)
  },
  dismissNotice: () => {
    if (timer) clearTimeout(timer)
    timer = null
    set({ notice: null })
  },
}))
