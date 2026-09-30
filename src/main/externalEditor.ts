import { spawn } from 'node:child_process'
import { constants, accessSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { splitArgs } from '../shared/argv'
import type { ExternalEditorRequest, ExternalEditorResult } from '../shared/types'

export const AUTO_EDITOR = 'auto'

export const KNOWN_EDITORS: readonly { bin: string; template: string }[] = [
  { bin: 'code', template: 'code -g {file}:{line}:{column}' },
  { bin: 'cursor', template: 'cursor -g {file}:{line}:{column}' },
  { bin: 'zed', template: 'zed {file}:{line}:{column}' },
]

export interface EditorTarget {
  file: string
  line?: number
  column?: number
}

function position(n: number | undefined): string {
  return String(Number.isInteger(n) && (n as number) > 0 ? n : 1)
}

export function expandTemplate(template: string, target: EditorTarget): string[] | null {
  const tokens = splitArgs(template)
  if (!tokens || tokens.length === 0) return null
  const values: Record<string, string> = {
    file: target.file,
    line: position(target.line),
    column: position(target.column),
  }
  const hasFile = tokens.some((t) => t.includes('{file}'))
  const argv = tokens.map((t) => t.replace(/\{(file|line|column)\}/g, (_m, key) => values[key]))
  return hasFile ? argv : [...argv, target.file]
}

export function findOnPath(
  bin: string,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, bin)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

export function resolveEditorTemplate(
  setting: string,
  pathEnv: string,
  isExecutable: (p: string) => boolean,
): string | null {
  const trimmed = setting.trim()
  if (!trimmed) return null
  if (trimmed !== AUTO_EDITOR) return trimmed
  const found = KNOWN_EDITORS.find((e) => findOnPath(e.bin, pathEnv, isExecutable))
  return found?.template ?? null
}

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function openInExternalEditor(req: ExternalEditorRequest): Promise<ExternalEditorResult> {
  if (typeof req?.file !== 'string' || !isAbsolute(req.file)) {
    return Promise.resolve({ ok: false, error: 'invalid-path' })
  }
  const template = resolveEditorTemplate(
    typeof req.template === 'string' ? req.template : AUTO_EDITOR,
    process.env.PATH ?? '',
    isExecutableFile,
  )
  if (!template) return Promise.resolve({ ok: false, error: 'no-editor' })
  const argv = expandTemplate(template, req)
  if (!argv) return Promise.resolve({ ok: false, error: 'invalid-template' })
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      shell: false,
    })
    child.once('error', (err) =>
      resolve({ ok: false, error: 'spawn-failed', message: err.message }),
    )
    child.once('spawn', () => {
      child.unref()
      resolve({ ok: true, argv })
    })
  })
}
