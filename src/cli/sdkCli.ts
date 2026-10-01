import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import { readManifest } from '../main/extensionManifest'
import { parseMarketplaceManifest, planCopy } from '../main/marketplace'
import { EXTENSION_MANIFEST_FILE, type ExtensionManifest } from '../shared/extensions'
import { MARKETPLACE_MANIFEST_FILE } from '../shared/marketplace'
import { PRODUCT_NAME } from '../shared/product'

export interface SdkCliResult {
  code: number
  lines: string[]
}

export const SDK_CLI_USAGE = [
  `usage: ${PRODUCT_NAME}-extension validate [folder]`,
  `       ${PRODUCT_NAME}-extension unlist <extension folder> [marketplace folder]`,
].join('\n')

const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
const CODE_LENGTH = 26

export function newInstallCode(): string {
  return Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte & 31]).join('')
}

type ExtensionCheck = { ok: true; manifest: ExtensionManifest } | { ok: false; problem: string }

function checkExtension(dir: string): ExtensionCheck {
  const res = readManifest(dir)
  if (!res.ok) return { ok: false, problem: res.error }
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
  for (const path of [...manifest.extensions, ...manifest.unlisted.map((entry) => entry.path)]) {
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
  const hidden = manifest.unlisted.length > 0 ? `, ${manifest.unlisted.length} unlisted` : ''
  return {
    code: 0,
    lines: [
      `ok: marketplace "${manifest.name}" with ${manifest.extensions.length} extension(s)${hidden}`,
    ],
  }
}

function unlist(dir: string, folder: string): SdkCliResult {
  const file = join(dir, MARKETPLACE_MANIFEST_FILE)
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return { code: 1, lines: [`${MARKETPLACE_MANIFEST_FILE}: ${(err as Error).message}`] }
  }
  const manifest = parseMarketplaceManifest(raw)
  if (typeof manifest === 'string') {
    return { code: 1, lines: [`${MARKETPLACE_MANIFEST_FILE}: ${manifest}`] }
  }
  const same = (path: string): boolean => normalize(path) === normalize(folder)
  const existing = manifest.unlisted.find((entry) => same(entry.path))
  if (existing) {
    return {
      code: 0,
      lines: [`${existing.path} is already unlisted: its install code is ${existing.code}`],
    }
  }
  const path = manifest.extensions.find(same)
  if (!path) {
    return { code: 1, lines: [`${folder}: not in the extensions of ${MARKETPLACE_MANIFEST_FILE}`] }
  }
  const code = newInstallCode()
  const next = {
    ...raw,
    extensions: manifest.extensions.filter((listed) => listed !== path),
    unlisted: [...manifest.unlisted, { path, code }],
  }
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return { code: 0, lines: [`unlisted ${path}: its install code is ${code}`] }
}

export function runSdkCli(argv: string[]): SdkCliResult {
  const [verb, ...args] = argv
  if (verb === 'unlist' && (args.length === 1 || args.length === 2)) {
    return unlist(resolve(args[1] ?? '.'), args[0] as string)
  }
  if (verb !== 'validate' || args.length > 1) return { code: 2, lines: [SDK_CLI_USAGE] }
  const dir = resolve(args[0] ?? '.')
  if (!isDirectory(dir)) return { code: 1, lines: [`${dir}: not a folder`] }
  if (existsSync(join(dir, MARKETPLACE_MANIFEST_FILE))) return validateMarketplace(dir)
  const check = checkExtension(dir)
  return check.ok
    ? { code: 0, lines: [`ok: extension ${check.manifest.id} ${check.manifest.version}`] }
    : { code: 1, lines: [`${EXTENSION_MANIFEST_FILE}: ${check.problem}`] }
}
