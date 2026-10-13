import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ipcMain } from 'electron'
import {
  SPEC_COMMAND_PATTERN,
  SPEC_FILE_MAX_BYTES,
  type SpecCommand,
  parseCompletionSpec,
} from '../../shared/terminal/completionSpec'

export interface CompletionSpecDeps {
  userDir: string
  extensionDirs: () => string[]
}

interface Cached {
  mtimeMs: number
  size: number
  spec: SpecCommand | null
}

const cache = new Map<string, Cached>()

function readSpec(path: string): SpecCommand | null | undefined {
  let st: ReturnType<typeof lstatSync>
  try {
    st = lstatSync(path)
  } catch {
    return undefined
  }
  if (!st.isFile() || st.size > SPEC_FILE_MAX_BYTES) return undefined
  const hit = cache.get(path)
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.spec
  let spec: SpecCommand | null = null
  try {
    const parsed = parseCompletionSpec(JSON.parse(readFileSync(path, 'utf8')))
    spec = parsed instanceof Error ? null : parsed
  } catch {
    spec = null
  }
  cache.set(path, { mtimeMs: st.mtimeMs, size: st.size, spec })
  return spec
}

export function loadCompletionSpec(command: string, dirs: readonly string[]): SpecCommand | null {
  if (!SPEC_COMMAND_PATTERN.test(command)) return null
  for (const dir of dirs) {
    const spec = readSpec(join(dir, `${command}.json`))
    if (spec) return spec
  }
  return null
}

export function registerCompletionIpc(deps: CompletionSpecDeps): void {
  ipcMain.handle('completions:spec', (_e, command: unknown) =>
    typeof command === 'string'
      ? loadCompletionSpec(command, [deps.userDir, ...deps.extensionDirs()])
      : null,
  )
}
