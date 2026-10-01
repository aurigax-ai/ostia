import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { localeProblems } from '../main/extensionLocales'
import { readManifest } from '../main/extensionManifest'
import { parseMarketplaceManifest, planCopy } from '../main/marketplace'
import { EXTENSION_MANIFEST_FILE, type ExtensionManifest } from '../shared/extensions'
import { MARKETPLACE_MANIFEST_FILE } from '../shared/marketplace'
import { PRODUCT_NAME } from '../shared/product'

export interface SdkCliResult {
  code: number
  lines: string[]
}

export const SDK_CLI_USAGE = `usage: ${PRODUCT_NAME}-extension validate [folder]`

type ExtensionCheck = { ok: true; manifest: ExtensionManifest } | { ok: false; problem: string }

function checkExtension(dir: string): ExtensionCheck {
  const res = readManifest(dir)
  if (!res.ok) return { ok: false, problem: res.error }
  const locales = localeProblems(dir, res.manifest)
  if (locales.length > 0) return { ok: false, problem: locales.join('; ') }
  const plan = planCopy(dir)
  if (plan.ok) return { ok: true, manifest: res.manifest }
  return {
    ok: false,
    problem:
      plan.error === 'too-large'
        ? 'too large to install from a marketplace'
        : 'holds a link or special file, which a marketplace install refuses',
  }
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function validateMarketplace(dir: string): SdkCliResult {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, MARKETPLACE_MANIFEST_FILE), 'utf8'))
  } catch (err) {
    return { code: 1, lines: [`${MARKETPLACE_MANIFEST_FILE}: ${(err as Error).message}`] }
  }
  const manifest = parseMarketplaceManifest(raw)
  if (typeof manifest === 'string') {
    return { code: 1, lines: [`${MARKETPLACE_MANIFEST_FILE}: ${manifest}`] }
  }
  const problems: string[] = []
  const ids = new Map<string, string>()
  for (const path of manifest.extensions) {
    const extDir = join(dir, path)
    if (!isDirectory(extDir)) {
      problems.push(`${path}: not a folder in the repository`)
      continue
    }
    const check = checkExtension(extDir)
    if (!check.ok) {
      problems.push(`${path}: ${check.problem}`)
      continue
    }
    const earlier = ids.get(check.manifest.id)
    if (earlier)
      problems.push(`${path}: duplicate extension id '${check.manifest.id}' (${earlier})`)
    else ids.set(check.manifest.id, path)
  }
  if (problems.length > 0) return { code: 1, lines: problems }
  return {
    code: 0,
    lines: [`ok: marketplace "${manifest.name}" with ${manifest.extensions.length} extension(s)`],
  }
}

export function runSdkCli(argv: string[]): SdkCliResult {
  const [verb, folder, ...rest] = argv
  if (verb !== 'validate' || rest.length > 0) return { code: 2, lines: [SDK_CLI_USAGE] }
  const dir = resolve(folder ?? '.')
  if (!isDirectory(dir)) return { code: 1, lines: [`${dir}: not a folder`] }
  if (existsSync(join(dir, MARKETPLACE_MANIFEST_FILE))) return validateMarketplace(dir)
  const check = checkExtension(dir)
  return check.ok
    ? { code: 0, lines: [`ok: extension ${check.manifest.id} ${check.manifest.version}`] }
    : { code: 1, lines: [`${EXTENSION_MANIFEST_FILE}: ${check.problem}`] }
}
