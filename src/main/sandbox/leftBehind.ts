import type { Dirent, Stats } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export type LeftBehindBaseline = ReadonlyMap<string, string>

const MAX_DEPTH = 6
const MAX_DIRS = 20_000
const SKIPPED_DIRS = new Set(['node_modules'])

function fileSignature(stat: Stats): string {
  return `f:${stat.ino}:${stat.size}:${stat.mtimeMs}`
}

async function signatureOf(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path)
    if (stat.isDirectory()) return 'd'
    return stat.isFile() ? fileSignature(stat) : null
  } catch {
    return null
  }
}

async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

async function noteGit(
  found: Map<string, string>,
  workDir: string,
  rel: string,
  isDirectory: boolean,
): Promise<void> {
  const git = join(workDir, rel)
  const own = await signatureOf(git)
  if (own) found.set(rel, own)
  if (!isDirectory) return
  const config = await signatureOf(join(git, 'config'))
  if (config) found.set(`${rel}/config`, config)
  for (const hook of await entriesOf(join(git, 'hooks'))) {
    if (!hook.isFile()) continue
    const sig = await signatureOf(join(git, 'hooks', hook.name))
    if (sig) found.set(`${rel}/hooks/${hook.name}`, sig)
  }
}

async function scan(workDir: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  let visited = 0
  const walk = async (rel: string, depth: number): Promise<void> => {
    if (visited++ >= MAX_DIRS) return
    const prefix = rel === '' ? '' : `${rel}/`
    const subdirs: string[] = []
    for (const entry of await entriesOf(join(workDir, rel))) {
      if (entry.name === '.git') {
        await noteGit(found, workDir, `${prefix}.git`, entry.isDirectory())
      } else if (entry.name === '.envrc' && entry.isFile()) {
        const sig = await signatureOf(join(workDir, prefix, '.envrc'))
        if (sig) found.set(`${prefix}.envrc`, sig)
      } else if (entry.isDirectory() && !SKIPPED_DIRS.has(entry.name) && depth < MAX_DEPTH) {
        subdirs.push(`${prefix}${entry.name}`)
      }
    }
    for (const sub of subdirs) await walk(sub, depth + 1)
  }
  await walk('', 0)
  return found
}

export async function leftBehindBaseline(workDir: string): Promise<LeftBehindBaseline> {
  return scan(workDir)
}

export async function leftBehindSince(
  workDir: string,
  baseline: LeftBehindBaseline,
): Promise<string[]> {
  const changed = [...(await scan(workDir))]
    .filter(([rel, sig]) => baseline.get(rel) !== sig)
    .map(([rel]) => rel)
  const newRepos = changed.filter((rel) => rel.endsWith('/.git') || rel === '.git')
  return changed
    .filter((rel) => !newRepos.some((repo) => rel !== repo && rel.startsWith(`${repo}/`)))
    .sort()
}

export function watchLeftBehind(workDir: string, onFound: (paths: string[]) => void): () => void {
  const baseline = leftBehindBaseline(workDir)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    void baseline
      .then((before) => leftBehindSince(workDir, before))
      .then((paths) => {
        if (paths.length > 0) onFound(paths)
      })
      .catch(() => undefined)
  }
}
