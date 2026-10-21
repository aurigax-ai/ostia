import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { EXTENSION_API_VERSION } from '@aurigax-ai/ostia-extension-sdk/contract/extensionApi'
import type { ExtensionManifest } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { agentSkillProblems } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { readManifest } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  lowestApiNeeded,
  newestCompatible,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionVersions'
import {
  MARKETPLACE_MANIFEST_FILE,
  parseMarketplaceManifest,
  type RevokedVersion,
} from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { isInsidePath } from '../../platform/pathGuard'

const MARKETPLACE_MANIFEST_MAX_BYTES = 64 * 1024

export interface CatalogEntry {
  dir: string
  manifest: ExtensionManifest
  code?: string
  needsApi?: string
}

export interface CatalogOptions {
  appApi?: string
  prerelease: (extId: string) => boolean
}

interface BrokenUnlisted {
  code: string
  problem: string
}

export interface Catalog {
  name: string
  description: string
  problems: string[]
  entries: CatalogEntry[]
  unlisted: boolean
  brokenUnlisted: BrokenUnlisted[]
  revoked: RevokedVersion[]
}

export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export function readCatalog(clone: string, options: CatalogOptions): Catalog | string {
  const name = MARKETPLACE_MANIFEST_FILE
  const file = join(clone, name)
  let raw: unknown
  try {
    const stat = lstatSync(file)
    if (!stat.isFile()) return `${name} is not a regular file`
    if (stat.size > MARKETPLACE_MANIFEST_MAX_BYTES) {
      return `${name} is larger than ${MARKETPLACE_MANIFEST_MAX_BYTES} bytes`
    }
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return `unreadable ${name}: ${(err as Error).message}`
  }
  const manifest = parseMarketplaceManifest(raw)
  if (typeof manifest === 'string') return manifest
  const root = realpathSync(clone)
  const problems: string[] = []
  const brokenUnlisted: BrokenUnlisted[] = []
  const read = (path: string): CatalogEntry | string => {
    const dir = join(clone, path)
    if (!isRealDirectory(dir) || !isInsidePath(root, realpathSync(dir))) {
      return 'not a folder in the repository'
    }
    const res = readManifest(dir, { anyApi: true })
    if (!res.ok) return res.error
    const skillProblems = agentSkillProblems(dir, res.manifest)
    return skillProblems.length > 0 ? skillProblems.join('; ') : { dir, manifest: res.manifest }
  }
  const current: CatalogEntry[] = []
  const offered: { path: string; code?: string }[] = [
    ...manifest.extensions.map((path) => ({ path })),
    ...manifest.unlisted,
  ]
  for (const { path, code } of offered) {
    const entry = read(path)
    if (typeof entry === 'string') {
      if (code) brokenUnlisted.push({ code, problem: entry })
      else problems.push(`${path}: ${entry}`)
    } else if (current.some((e) => e.manifest.id === entry.manifest.id)) {
      const problem = `duplicate extension id '${entry.manifest.id}'`
      if (code) brokenUnlisted.push({ code, problem })
      else problems.push(`${path}: ${problem}`)
    } else {
      current.push({ ...entry, ...(code ? { code } : {}) })
    }
  }
  const older: CatalogEntry[] = []
  for (const path of manifest.history) {
    const entry = read(path)
    if (typeof entry === 'string') problems.push(`${path}: ${entry}`)
    else older.push(entry)
  }
  const revoked = new Set(manifest.revoked.map(({ id, version }) => `${id}@${version}`))
  const isRevoked = (entry: CatalogEntry): boolean =>
    revoked.has(`${entry.manifest.id}@${entry.manifest.version}`)
  const entries: CatalogEntry[] = []
  for (const entry of current) {
    const history = older.filter((e) => e.manifest.id === entry.manifest.id)
    const resolved = resolveRelease(entry, history, isRevoked, options)
    if (resolved) entries.push(resolved)
    else if (!entry.code) problems.push(`${entry.manifest.id}: every release was revoked`)
  }
  return {
    name: manifest.name,
    description: manifest.description,
    problems,
    entries,
    unlisted: manifest.unlisted.length > 0,
    brokenUnlisted,
    revoked: manifest.revoked,
  }
}

function resolveRelease(
  listed: CatalogEntry,
  older: CatalogEntry[],
  isRevoked: (entry: CatalogEntry) => boolean,
  options: CatalogOptions,
): CatalogEntry | null {
  const appApi = options.appApi ?? EXTENSION_API_VERSION
  const offerable = [listed, ...older].filter((entry) => !isRevoked(entry))
  const candidates = offerable.map((entry) => ({
    version: entry.manifest.version,
    api: entry.manifest.api,
    entry,
  }))
  const chosen = newestCompatible(candidates, appApi, options.prerelease(listed.manifest.id))
  if (chosen) return { ...chosen.entry, ...(listed.code ? { code: listed.code } : {}) }
  if (candidates.length === 0) return null
  const needsApi = lowestApiNeeded(candidates) ?? listed.manifest.api
  return { ...listed, needsApi }
}
