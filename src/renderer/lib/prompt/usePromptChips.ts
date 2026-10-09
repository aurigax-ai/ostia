import { usePromptExtensionChips } from '@/lib/extensions/extensionChips'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import type { PromptContext } from '@shared/types'
import { useEffect, useMemo, useState } from 'react'
import {
  type CoreChipInputs,
  type ResolvedChip,
  contextRequest,
  lastCommand,
  needsClock,
  resolvePromptChips,
} from './promptChips'

const CLOCK_TICK_MS = 15_000

function useClock(enabled: boolean): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    if (!enabled) return
    setNow(new Date())
    const timer = setInterval(() => setNow(new Date()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export interface PromptChipsResult {
  chips: ResolvedChip[]
  inputs: CoreChipInputs
}

export function usePromptChips(
  paneId: string | null,
  cwd: string | undefined,
  order: readonly string[],
  active: boolean,
): PromptChipsResult {
  const locale = useSettingsStore((s) => s.locale)
  const promptLine = useBlocksStore((s) => (paneId ? s.drafts[paneId]?.promptLine : undefined))
  const blocks = useBlocksStore((s) => (paneId ? s.byPane[paneId] : undefined))
  const contributed = usePromptExtensionChips(paneId, order, active)
  const [context, setContext] = useState<PromptContext | null>(null)
  const want = contextRequest(order)
  const now = useClock(active && needsClock(order))

  // biome-ignore lint/correctness/useExhaustiveDependencies: promptLine refetches at each new prompt
  useEffect(() => {
    if (!active || !paneId) return
    let live = true
    window.ostia.pty
      .promptContext(paneId, { node: want.node, kube: want.kube })
      .then((next) => {
        if (live) setContext(next)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [paneId, active, promptLine, want.node, want.kube])

  const last = useMemo(() => lastCommand(blocks), [blocks])
  const inputs: CoreChipInputs = { cwd, context, lastCommand: last, now, locale }
  const chips = resolvePromptChips(order, inputs, contributed)
  return { chips, inputs }
}
