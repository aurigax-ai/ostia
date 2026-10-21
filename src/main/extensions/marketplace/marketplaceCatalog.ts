import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ExtensionManifest } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { agentSkillProblems } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import { readManifest } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  MARKETPLACE_MANIFEST_FILE,
  parseMarketplaceManifest,
} from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { isInsidePath } from '../../platform/pathGuard'

const MARKETPLACE_MANIFEST_MAX_BYTES = 64 * 1024

export interface CatalogEntry {
  dir: string
  manifest: ExtensionManifest
  code?: string
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
}

export function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export function readCatalog(clone: string): Catalog | string {
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
  const entries: CatalogEntry[] = []
  const brokenUnlisted: BrokenUnlisted[] = []
  const offered: { path: string; code?: string }[] = [
    ...manifest.extensions.map((path) => ({ path })),
    ...manifest.unlisted,
  ]
  for (const { path, code } of offered) {
    const refuse = (problem: string): void => {
      if (code) brokenUnlisted.push({ code, problem })
      else problems.push(`${path}: ${problem}`)
    }
    const dir = join(clone, path)
    if (!isRealDirectory(dir) || !isInsidePath(root, realpathSync(dir))) {
      refuse('not a folder in the repository')
      continue
    }
    const res = readManifest(dir)
    const skillProblems = res.ok ? agentSkillProblems(dir, res.manifest) : []
    if (!res.ok) {
      refuse(res.error)
    } else if (skillProblems.length > 0) {
      refuse(skillProblems.join('; '))
    } else if (entries.some((e) => e.manifest.id === res.manifest.id)) {
      refuse(`duplicate extension id '${res.manifest.id}'`)
    } else {
      entries.push({ dir, manifest: res.manifest, ...(code ? { code } : {}) })
    }
  }
  return {
    name: manifest.name,
    description: manifest.description,
    problems,
    entries,
    unlisted: manifest.unlisted.length > 0,
    brokenUnlisted,
  }
}
