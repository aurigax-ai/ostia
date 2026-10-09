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

const WORD_DIFF_LIMIT = 600

function words(text: string): string[] {
  return text.match(/\s+|[^\s]+/g) ?? []
}

export function wordDiff(before: string, after: string): DiffPart[] {
  const a = words(before)
  const b = words(after)
  if (a.length > WORD_DIFF_LIMIT || b.length > WORD_DIFF_LIMIT) {
    return [{ at: 0, text: after, changed: before !== after }]
  }
  const table: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  )
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1])
    }
  }
  const parts: DiffPart[] = []
  let at = 0
  const push = (text: string, changed: boolean): void => {
    const last = parts[parts.length - 1]
    if (last && last.changed === changed) last.text += text
    else parts.push({ at, text, changed })
    at += text.length
  }
  let i = 0
  let j = 0
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      push(b[j], false)
      i++
      j++
    } else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) {
      i++
    } else {
      push(b[j], !/^\s+$/.test(b[j]))
      j++
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
