export const OPEN_FILES_COMMAND = 'editor.openFiles'
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

export type OpenFilesResult =
  | { ok: true; results: OpenFileVerdict[] }
  | { ok: false; error: string; message: string }

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
