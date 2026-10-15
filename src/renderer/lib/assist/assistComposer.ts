import { diffWordsWithSpace } from 'diff'

export type ComposerMode = 'agent' | 'shell'

export function composerModeFor(state: {
  agent: boolean
  idlePrompt: boolean
  inputReady: boolean
  commandReady: boolean
}): ComposerMode | null {
  if (state.agent) return state.inputReady ? 'agent' : null
  if (state.idlePrompt) return state.commandReady ? 'shell' : null
  return null
}

export interface DiffPart {
  at: number
  text: string
  changed: boolean
}

const WORD_DIFF_MAX_EDITS = 600

export function wordDiff(before: string, after: string): DiffPart[] {
  const changes = diffWordsWithSpace(before, after, { maxEditLength: WORD_DIFF_MAX_EDITS })
  if (!changes) return [{ at: 0, text: after, changed: true }]
  const parts: DiffPart[] = []
  let at = 0
  for (const change of changes) {
    if (change.removed) continue
    for (const piece of change.value.split(/(\s+)/)) {
      if (!piece) continue
      const changed = change.added && /\S/.test(piece)
      const last = parts.at(-1)
      if (last && last.changed === changed) last.text += piece
      else parts.push({ at, text: piece, changed })
      at += piece.length
    }
  }
  return parts
}

export interface LatestRequest {
  run: (fn: (signal: AbortSignal) => Promise<void>, delayMs: number) => void
  cancel: () => void
}

export function latestRequest(): LatestRequest {
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  const cancel = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }
  return {
    run: (fn, delayMs) => {
      cancel()
      const current = new AbortController()
      controller = current
      timer = setTimeout(() => {
        timer = undefined
        void fn(current.signal)
      }, delayMs)
    },
    cancel,
  }
}

export const NATURAL_COMMAND_PATTERN = /^#\s+(\S[\s\S]{2,})$/

export function naturalCommandQuery(draft: string): string | null {
  const match = NATURAL_COMMAND_PATTERN.exec(draft)
  return match ? match[1].trim() : null
}
