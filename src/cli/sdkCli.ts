import { randomBytes } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join, normalize, relative, resolve } from 'node:path'
import { agentSkillProblems } from '../main/agentSkills'
import { localeProblems } from '../main/extensionLocales'
import { EXTENSION_ID_PATTERN, readManifest } from '../main/extensionManifest'
import { parseMarketplaceManifest, planCopy } from '../main/marketplace'
import { EXTENSION_MANIFEST_FILE, type ExtensionManifest } from '../shared/extensions'
import { MARKETPLACE_MANIFEST_FILE } from '../shared/marketplace'
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from '../shared/product'

export interface SdkCliResult {
  code: number
  lines: string[]
}

export const SDK_CLI_USAGE = [
  `usage: ${LEGACY_PRODUCT_NAME}-extension create <id> [folder]`,
  `       ${LEGACY_PRODUCT_NAME}-extension validate [folder]`,
  `       ${LEGACY_PRODUCT_NAME}-extension unlist <extension folder> [marketplace folder]`,
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
  const problems = [...localeProblems(dir, res.manifest), ...agentSkillProblems(dir, res.manifest)]
  if (problems.length > 0) return { ok: false, problem: problems.join('; ') }
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

const TEMPLATE_ID = 'hello'
const TEMPLATE_NAME = 'Hello'
const TEMPLATE_IGNORES = 'node_modules\ndist\n'
const TEMPLATE_LOCALES = 'locales'

function titleOf(id: string): string {
  return id
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

function rewriteJson(file: string, change: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  change(value)
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function create(id: string, target: string, templateDir: string): SdkCliResult {
  if (!EXTENSION_ID_PATTERN.test(id)) {
    return {
      code: 1,
      lines: [
        `${id}: an id is 2 to 40 lowercase letters, digits or dashes, starting with a letter`,
      ],
    }
  }
  if (!isDirectory(templateDir)) return { code: 1, lines: [`${templateDir}: template not found`] }
  if (existsSync(target) && (!isDirectory(target) || readdirSync(target).length > 0)) {
    return { code: 1, lines: [`${target}: already exists and is not empty`] }
  }
  const name = titleOf(id)
  mkdirSync(target, { recursive: true })
  cpSync(templateDir, target, { recursive: true })
  writeFileSync(join(target, '.gitignore'), TEMPLATE_IGNORES)
  rewriteJson(join(target, 'package.json'), (pkg) => {
    pkg.name = `${LEGACY_PRODUCT_NAME}-extension-${id}`
    const scripts = pkg.scripts as Record<string, string>
    scripts.validate = scripts.validate.replace(`dist/${TEMPLATE_ID}`, `dist/${id}`)
  })
  const renamed: string[] = []
  rewriteJson(join(target, EXTENSION_MANIFEST_FILE), (manifest) => {
    manifest.id = id
    if (manifest.name !== name) renamed.push('name')
    manifest.name = name
    const { commands } = manifest.contributes as { commands: Record<string, string>[] }
    for (const command of commands) {
      const title = command.title.replace(TEMPLATE_NAME, name)
      if (command.title !== title) renamed.push(`commands.${command.id}.title`)
      if (command.category !== name) renamed.push(`commands.${command.id}.category`)
      command.title = title
      command.category = name
    }
  })
  const catalogs = join(target, TEMPLATE_LOCALES)
  for (const file of isDirectory(catalogs) ? readdirSync(catalogs) : []) {
    rewriteJson(join(catalogs, file), (catalog) => {
      const translated = (catalog.manifest ?? {}) as Record<string, string>
      for (const slot of renamed) delete translated[slot]
    })
  }
  const folder = relative(process.cwd(), target) || '.'
  return {
    code: 0,
    lines: [
      `created the ${name} extension in ${folder}`,
      '',
      `  cd ${folder}`,
      '  pnpm install',
      `  pnpm validate   builds dist/${id} and checks it the way ${PRODUCT_NAME} will`,
    ],
  }
}

export function runSdkCli(
  argv: string[],
  templateDir: string = join(__dirname, '../template'),
): SdkCliResult {
  const [verb, ...args] = argv
  if (verb === 'create' && (args.length === 1 || args.length === 2)) {
    return create(args[0] as string, resolve(args[1] ?? (args[0] as string)), templateDir)
  }
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
