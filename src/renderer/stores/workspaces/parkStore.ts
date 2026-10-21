import type { ParkRefusal } from '@shared/park/park'
import { create } from 'zustand'

const PARK_NOTICE_MS = 15_000

interface ParkPromptRequest {
  workspaceId: string
  paneId: string
  title: string
}

type ParkNotice =
  | { kind: 'parked'; workspaceId: string; title: string; seq: number }
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
  | { kind: 'refused'; workspaceId: string; paneId: string; title: string; reason: ParkRefusal }

interface ParkState {
  prompt: ParkPromptRequest | null
  notice: ParkNotice | null
  openPrompt: (request: ParkPromptRequest) => void
  closePrompt: () => void
  showNotice: (notice: NoticeInput) => void
  dismissNotice: () => void
}

let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null

export const useParkStore = create<ParkState>((set, get) => ({
  prompt: null,
  notice: null,
  openPrompt: (request) => set({ prompt: request, notice: null }),
  closePrompt: () => set({ prompt: null }),
  showNotice: (notice) => {
    const next = { ...notice, seq: ++seq } as ParkNotice
    if (timer) clearTimeout(timer)
    set({ notice: next, prompt: null })
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
