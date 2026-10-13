export const OPEN_FILES_COMMAND = 'editor.openFiles'
export const REVEAL_FOLDER_COMMAND = 'files.reveal'
export const OPEN_FILES_MAX = 32

export interface FileTarget {
  path: string
  line?: number
  column?: number
}

export type OpenFileError =
  | 'not-found'
  | 'directory'
  | 'not-a-file'
  | 'unreadable'
  | 'outside-sandbox'

export type OpenFileVerdict =
  | { ok: true; path: string }
  | { ok: false; path: string; error: OpenFileError }

export type WaitOutcome = 'closed' | 'gone'

export type OpenFilesResult =
  | { ok: true; results: OpenFileVerdict[]; waited?: WaitOutcome }
  | { ok: false; error: string; message: string }

export const OPEN_DIFF_COMMAND = 'diff.openFiles'
export const OPEN_PLACEMENTS = ['tab', 'right', 'down'] as const
export type OpenPlacement = (typeof OPEN_PLACEMENTS)[number]

export function parsePlacement(value: unknown): OpenPlacement | undefined {
  return OPEN_PLACEMENTS.find((placement) => placement === value)
}

export interface OpenedPane {
  path: string
  paneId: string
}

export function openedPaneIds(result: unknown): string[] {
  const opened = (result as { opened?: unknown } | null)?.opened
  if (!Array.isArray(opened)) return []
  return opened.flatMap((entry) =>
    typeof (entry as OpenedPane | null)?.paneId === 'string' ? [(entry as OpenedPane).paneId] : [],
  )
}

export type DiffFilesError =
  | 'invalid-args'
  | 'not-found'
  | 'directory'
  | 'not-a-file'
  | 'unreadable'
  | 'outside-sandbox'
  | 'binary'
  | 'too-large'

export type DiffFilesResult =
  | { ok: true; waited?: WaitOutcome }
  | { ok: false; error: DiffFilesError | string; path?: string; message?: string }

function position(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

export function parseFileTargets(raw: unknown): FileTarget[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > OPEN_FILES_MAX) return null
  const targets: FileTarget[] = []
  for (const item of raw) {
    const entry = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>
    if (typeof entry.path !== 'string' || entry.path.length === 0) return null
    const line = position(entry.line)
    const column = line ? position(entry.column) : undefined
    targets.push({ path: entry.path, ...(line ? { line } : {}), ...(column ? { column } : {}) })
  }
  return targets
}

export type RevealFolderError = 'invalid-args' | 'outside-home' | 'not-found' | 'not-a-directory'

export type RevealFolderResult =
  | { ok: true; path: string }
  | { ok: false; error: RevealFolderError | string; message?: string }

export type OpenTargetKind = 'url' | 'stdin' | 'path'

export function openTargetKind(word: string): OpenTargetKind {
  if (word === '-') return 'stdin'
  return /^https?:\/\//i.test(word) ? 'url' : 'path'
}
