import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { type AtomicWriteOptions, writeFileAtomic, writeFileAtomicAsync } from './atomicWrite'
import { appDataDir } from './userDirs'

export type StoreScope = 'project' | 'global'

export function storePath(name: string, scope: StoreScope, workDir?: string): string {
  if (scope === 'project') {
    const base = workDir?.trim() ? workDir : process.cwd()
    return projectFile(base, `${name}.json`)
  }
  return join(appDataDir(), `${name}.json`)
}

export const PROJECT_DIR = `.${PRODUCT_NAME}`

function projectFile(workDir: string, ...parts: string[]): string {
  return join(workDir, PROJECT_DIR, ...parts)
}

export function loadJson<T>(path: string, fallback: T): T {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback
  } catch {
    return fallback
  }
}

const SECURE: AtomicWriteOptions = { mode: 0o600, dirMode: 0o700 }

export function saveJson(path: string, data: unknown, opts?: { secure?: boolean }): void {
  writeFileAtomic(path, JSON.stringify(data, null, 2), opts?.secure ? SECURE : {})
}

export async function saveJsonAsync(
  path: string,
  data: unknown,
  opts?: { secure?: boolean },
): Promise<void> {
  await writeFileAtomicAsync(path, JSON.stringify(data), opts?.secure ? SECURE : {})
}
