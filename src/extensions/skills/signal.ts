export const PROMPT_MAX = 2000
export const SIGNAL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
export const SIGNALS_MAX_BYTES = 2 * 1024 * 1024

type SignalAgent = 'claude' | 'codex'

export interface Signal {
  id: string
  at: number
  kind: 'prompt'
  agent: SignalAgent
  text: string
  session: string
  pane: string
  workspace: string
  project: string | null
  stacks: string[]
}

export type SignalDraft = Omit<Signal, 'id'>

export function parseSignalLine(line: string): Signal | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  const s = raw as Partial<Signal> | null
  const valid =
    typeof s?.id === 'string' &&
    /^s\d{1,9}$/.test(s.id) &&
    typeof s.at === 'number' &&
    s.kind === 'prompt' &&
    (s.agent === 'claude' || s.agent === 'codex') &&
    typeof s.text === 'string' &&
    typeof s.session === 'string' &&
    typeof s.pane === 'string' &&
    typeof s.workspace === 'string' &&
    (s.project === null || typeof s.project === 'string') &&
    Array.isArray(s.stacks) &&
    s.stacks.every((x) => typeof x === 'string')
  return valid ? (s as Signal) : null
}
