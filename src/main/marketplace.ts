import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { EXTENSION_MANIFEST_FILE, type ExtensionManifest } from '../shared/extensions'
import {
  MARKETPLACE_FEATURE,
  MARKETPLACE_MANIFEST_FILE,
  MARKETPLACE_URL_MAX,
  type MarketplaceError,
  type MarketplaceExtension,
  type MarketplaceInfo,
  type MarketplaceInstallState,
  type MarketplaceResult,
  type MarketplaceState,
} from '../shared/marketplace'
import { EXTENSION_ID_PATTERN, isInsideDir, readManifest } from './extensionManifest'
import { loadJson, saveJson } from './jsonStore'
import { missingRequirements } from './systemRequirements'

export const MARKETPLACE_MANIFEST_MAX_BYTES = 64 * 1024
export const MARKETPLACE_MAX_EXTENSIONS = 200
export const EXTENSION_MAX_FILES = 8000
export const EXTENSION_MAX_BYTES = 50 * 1024 * 1024
const GIT_TIMEOUT_MS = 120_000
const DETAIL_MAX = 400
export const MARKETPLACE_NAME_MAX = 80
export const MARKETPLACE_DESCRIPTION_MAX = 500

const GITHUB_SHORTHAND = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9_.-]+$/
const SCP_LIKE = /^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:[A-Za-z0-9_./~-]+$/

export function normalizeMarketplaceUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const text = input.trim()
  if (!text || text.length > MARKETPLACE_URL_MAX || text.startsWith('-')) return null
  if (/[\s\p{Cc}]/u.test(text)) return null
  if (isAbsolute(text)) return resolve(text)
  if (GITHUB_SHORTHAND.test(text)) return `https://github.com/${text.replace(/\.git$/, '')}.git`
  if (SCP_LIKE.test(text)) return text
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return null
  }
  if (url.protocol === 'https:') return url.username || url.password ? null : url.href
  if (url.protocol === 'ssh:') return url.password ? null : url.href
  return null
}

export function marketplaceId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12)
}

export interface MarketplaceManifest {
  name: string
  description: string
  extensions: string[]
}

export function parseMarketplaceManifest(raw: unknown): MarketplaceManifest | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'the marketplace file must be a JSON object'
  }
  const { name, description, extensions } = raw as Record<string, unknown>
  if (typeof name !== 'string' || !name.trim() || name.length > MARKETPLACE_NAME_MAX) {
    return `name must be 1-${MARKETPLACE_NAME_MAX} characters`
  }
  if (description !== undefined && typeof description !== 'string') {
    return 'description must be a string'
  }
  if (!Array.isArray(extensions) || extensions.length > MARKETPLACE_MAX_EXTENSIONS) {
    return `extensions must be an array of at most ${MARKETPLACE_MAX_EXTENSIONS} folder paths`
  }
  for (const [i, path] of extensions.entries()) {
    if (typeof path !== 'string' || !path || isAbsolute(path) || !isInsideDir('/root', path)) {
      return `extensions[${i}] must be a folder path inside the repository`
    }
  }
  return {
    name: name.trim(),
    description: (description ?? '').slice(0, MARKETPLACE_DESCRIPTION_MAX),
    extensions: [...new Set(extensions as string[])],
  }
}

export type CopyPlan = { ok: true; files: string[] } | { ok: false; error: MarketplaceError }

export function planCopy(dir: string): CopyPlan {
  const files: string[] = []
  let bytes = 0
  const pending = ['']
  while (pending.length > 0) {
    const rel = pending.pop() as string
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = join(rel, entry.name)
      if (rel === '' && entry.name === '.git') continue
      if (entry.isDirectory()) {
        pending.push(path)
        continue
      }
      if (!entry.isFile()) return { ok: false, error: 'invalid-extension' }
      bytes += lstatSync(join(dir, path)).size
      files.push(path)
      if (files.length > EXTENSION_MAX_FILES || bytes > EXTENSION_MAX_BYTES) {
        return { ok: false, error: 'too-large' }
      }
    }
  }
  return { ok: true, files }
}

interface Source {
  id: string
  url: string
}

interface Records {
  sources: Source[]
  installs: Record<string, string>
}

function sanitizeRecords(raw: unknown): Records {
  const records: Records = { sources: [], installs: {} }
  if (typeof raw !== 'object' || raw === null) return records
  const { sources, installs } = raw as { sources?: unknown; installs?: unknown }
  if (Array.isArray(sources)) {
    for (const source of sources) {
      const url = normalizeMarketplaceUrl((source as { url?: unknown } | null)?.url)
      if (url && !records.sources.some((s) => s.url === url)) {
        records.sources.push({ id: marketplaceId(url), url })
      }
    }
  }
  if (typeof installs === 'object' && installs !== null && !Array.isArray(installs)) {
    for (const [extId, source] of Object.entries(installs)) {
      if (EXTENSION_ID_PATTERN.test(extId) && typeof source === 'string') {
        records.installs[extId] = source
      }
    }
  }
  return records
}

export type GitRunner = (args: string[]) => Promise<void>

export class GitError extends Error {
  constructor(
    readonly code: MarketplaceError,
    message: string,
  ) {
    super(message)
  }
}

export const runGit: GitRunner = (args) =>
  new Promise((done, fail) => {
    execFile(
      'git',
      args,
      {
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, _stdout, stderr) => {
        if (!err) return done()
        const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
        fail(new GitError(missing ? 'git-missing' : 'clone-failed', String(stderr || err.message)))
      },
    )
  })

export interface MarketplaceDeps {
  recordsPath: string
  clonesDir: string
  extensionsDir: string
  builtinIds: () => string[]
  forget: (extId: string) => void
  rescan: () => void
  git?: GitRunner
  gitMissing?: () => boolean
}

interface CatalogEntry {
  dir: string
  manifest: ExtensionManifest
}

interface Catalog {
  name: string
  description: string
  problems: string[]
  entries: CatalogEntry[]
}

function clip(text: string): string {
  return text.trim().slice(0, DETAIL_MAX)
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

function readCatalog(clone: string): Catalog | string {
  const file = join(clone, MARKETPLACE_MANIFEST_FILE)
  let raw: unknown
  try {
    const stat = lstatSync(file)
    if (!stat.isFile()) return `${MARKETPLACE_MANIFEST_FILE} is not a regular file`
    if (stat.size > MARKETPLACE_MANIFEST_MAX_BYTES) {
      return `${MARKETPLACE_MANIFEST_FILE} is larger than ${MARKETPLACE_MANIFEST_MAX_BYTES} bytes`
    }
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    return `unreadable ${MARKETPLACE_MANIFEST_FILE}: ${(err as Error).message}`
  }
  const manifest = parseMarketplaceManifest(raw)
  if (typeof manifest === 'string') return manifest
  const root = realpathSync(clone)
  const problems: string[] = []
  const entries: CatalogEntry[] = []
  for (const path of manifest.extensions) {
    const dir = join(clone, path)
    if (!isRealDirectory(dir) || relative(root, realpathSync(dir)).startsWith('..')) {
      problems.push(`${path}: not a folder in the repository`)
      continue
    }
    const res = readManifest(dir)
    if (!res.ok) {
      problems.push(`${path}: ${res.error}`)
    } else if (entries.some((e) => e.manifest.id === res.manifest.id)) {
      problems.push(`${path}: duplicate extension id '${res.manifest.id}'`)
    } else {
      entries.push({ dir, manifest: res.manifest })
    }
  }
  return { name: manifest.name, description: manifest.description, problems, entries }
}

export interface LanguageListing {
  marketplaceId: string
  extId: string
  name: string
  languages: string[]
}

export class Marketplace {
  private records: Records
  private queue: Promise<unknown> = Promise.resolve()
  private listed: LanguageListing[] | null = null

  constructor(private readonly deps: MarketplaceDeps) {
    this.records = sanitizeRecords(loadJson<unknown>(deps.recordsPath, {}))
  }

  private save(): void {
    this.listed = null
    saveJson(this.deps.recordsPath, this.records)
  }

  languageListings(): LanguageListing[] {
    if (this.listed) return this.listed
    const listed: LanguageListing[] = []
    for (const source of this.records.sources) {
      const dir = this.cloneDir(source.id)
      const catalog = existsSync(dir) ? readCatalog(dir) : null
      if (catalog === null || typeof catalog === 'string') continue
      for (const { manifest } of catalog.entries) {
        const languages = (manifest.contributes.languageServers ?? []).flatMap((s) => s.languages)
        if (this.installState(source.id, manifest) === 'conflict') continue
        listed.push({
          marketplaceId: source.id,
          extId: manifest.id,
          name: manifest.name,
          languages: [...new Set(languages)],
        })
      }
    }
    this.listed = listed
    return listed
  }

  private cloneDir(id: string): string {
    return join(this.deps.clonesDir, id)
  }

  private installDir(extId: string): string {
    return join(this.deps.extensionsDir, extId)
  }

  private installedVersion(extId: string): string | undefined {
    const res = readManifest(this.installDir(extId))
    return res.ok ? res.manifest.version : undefined
  }

  private installState(sourceId: string, manifest: ExtensionManifest): MarketplaceInstallState {
    if (this.deps.builtinIds().includes(manifest.id)) return 'conflict'
    if (!existsSync(this.installDir(manifest.id))) return 'available'
    if (this.records.installs[manifest.id] !== sourceId) return 'conflict'
    return this.installedVersion(manifest.id) === manifest.version ? 'installed' : 'update'
  }

  private info(source: Source): MarketplaceInfo {
    const base = { id: source.id, url: source.url }
    const catalog = existsSync(this.cloneDir(source.id))
      ? readCatalog(this.cloneDir(source.id))
      : 'not downloaded yet'
    if (typeof catalog === 'string') {
      return {
        ...base,
        name: source.url,
        description: '',
        error: catalog,
        problems: [],
        extensions: [],
      }
    }
    return {
      ...base,
      name: catalog.name,
      description: catalog.description,
      problems: catalog.problems,
      extensions: catalog.entries.map(({ manifest }): MarketplaceExtension => {
        const state = this.installState(source.id, manifest)
        const installedVersion = state === 'update' ? this.installedVersion(manifest.id) : undefined
        return {
          id: manifest.id,
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          category: manifest.category,
          capabilities: manifest.capabilities,
          runsProcess:
            manifest.main !== undefined || (manifest.contributes.languageServers ?? []).length > 0,
          state,
          ...(installedVersion ? { installedVersion } : {}),
        }
      }),
    }
  }

  state(): MarketplaceState {
    return {
      marketplaces: this.records.sources.map((source) => this.info(source)),
      installed: Object.keys(this.records.installs).filter((id) => existsSync(this.installDir(id))),
    }
  }

  private ok(): MarketplaceResult {
    return { ok: true, state: this.state() }
  }

  private fail(error: MarketplaceError, detail?: string): MarketplaceResult {
    return { ok: false, error, ...(detail ? { detail: clip(detail) } : {}), state: this.state() }
  }

  private serialized(task: () => Promise<MarketplaceResult>): Promise<MarketplaceResult> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private gitMissing(): boolean {
    return (this.deps.gitMissing ?? (() => missingRequirements(MARKETPLACE_FEATURE).length > 0))()
  }

  private async download(source: Source): Promise<MarketplaceResult | null> {
    if (this.gitMissing()) return this.fail('git-missing')
    const target = this.cloneDir(source.id)
    const staging = `${target}.next`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(this.deps.clonesDir, { recursive: true })
    try {
      await (this.deps.git ?? runGit)([
        'clone',
        '--depth',
        '1',
        '--no-tags',
        '--single-branch',
        '--no-recurse-submodules',
        '-c',
        'core.symlinks=false',
        '--',
        source.url,
        staging,
      ])
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      const code = err instanceof GitError ? err.code : 'clone-failed'
      return this.fail(code, (err as Error).message)
    }
    const catalog = readCatalog(staging)
    if (typeof catalog === 'string') {
      rmSync(staging, { recursive: true, force: true })
      return this.fail('invalid-marketplace', catalog)
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    this.listed = null
    return null
  }

  private async addSource(input: unknown): Promise<MarketplaceResult> {
    const url = normalizeMarketplaceUrl(input)
    if (!url) return this.fail('invalid-url')
    if (this.records.sources.some((s) => s.url === url)) return this.fail('already-added')
    const source = { id: marketplaceId(url), url }
    const failure = await this.download(source)
    if (failure) return failure
    this.records = { ...this.records, sources: [...this.records.sources, source] }
    this.save()
    return this.ok()
  }

  add(input: unknown): Promise<MarketplaceResult> {
    return this.serialized(() => this.addSource(input))
  }

  private sourceListing(extId: string, onlyUrl: string | null): Source | undefined {
    return this.records.sources.find((source) => {
      if (onlyUrl !== null && source.url !== onlyUrl) return false
      const dir = this.cloneDir(source.id)
      const catalog = existsSync(dir) ? readCatalog(dir) : null
      if (catalog === null || typeof catalog === 'string') return false
      const entry = catalog.entries.find((e) => e.manifest.id === extId)
      return entry !== undefined && this.installState(source.id, entry.manifest) !== 'conflict'
    })
  }

  installSuggested(
    extId: unknown,
    officialUrl: string,
    officialOnly: boolean,
  ): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      if (typeof extId !== 'string' || !EXTENSION_ID_PATTERN.test(extId)) {
        return this.fail('unknown-extension')
      }
      const official = normalizeMarketplaceUrl(officialUrl)
      const only = officialOnly ? official : null
      if (officialOnly && !official) return this.fail('unknown-extension')
      let source = this.sourceListing(extId, only)
      if (!source) {
        if (!official || this.records.sources.some((s) => s.url === official)) {
          return this.fail('unknown-extension')
        }
        const added = await this.addSource(official)
        if (!added.ok) return added
        source = this.sourceListing(extId, only)
        if (!source) return this.fail('unknown-extension')
      }
      return this.installFrom(source.id, extId)
    })
  }

  refresh(id: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      const source = this.records.sources.find((s) => s.id === id)
      if (!source) return this.fail('unknown-marketplace')
      return (await this.download(source)) ?? this.ok()
    })
  }

  remove(id: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      const source = this.records.sources.find((s) => s.id === id)
      if (!source) return this.fail('unknown-marketplace')
      rmSync(this.cloneDir(source.id), { recursive: true, force: true })
      this.records = {
        ...this.records,
        sources: this.records.sources.filter((s) => s.id !== source.id),
      }
      this.save()
      return this.ok()
    })
  }

  install(id: unknown, extId: unknown): Promise<MarketplaceResult> {
    return this.serialized(() => this.installFrom(id, extId))
  }

  private async installFrom(id: unknown, extId: unknown): Promise<MarketplaceResult> {
    const source = this.records.sources.find((s) => s.id === id)
    if (!source) return this.fail('unknown-marketplace')
    const catalog = readCatalog(this.cloneDir(source.id))
    if (typeof catalog === 'string') return this.fail('invalid-marketplace', catalog)
    const entry = catalog.entries.find((e) => e.manifest.id === extId)
    if (!entry) return this.fail('unknown-extension')
    const state = this.installState(source.id, entry.manifest)
    if (state === 'conflict') return this.fail('conflict')
    const plan = planCopy(entry.dir)
    if (!plan.ok) return this.fail(plan.error)
    const target = this.installDir(entry.manifest.id)
    try {
      if (state === 'available') this.deps.forget(entry.manifest.id)
      rmSync(target, { recursive: true, force: true })
      const manifestLast = [
        ...plan.files.filter((f) => f !== EXTENSION_MANIFEST_FILE),
        EXTENSION_MANIFEST_FILE,
      ]
      for (const file of manifestLast) {
        mkdirSync(dirname(join(target, file)), { recursive: true })
        copyFileSync(join(entry.dir, file), join(target, file))
      }
    } catch (err) {
      rmSync(target, { recursive: true, force: true })
      this.deps.rescan()
      return this.fail('write-failed', (err as Error).message)
    }
    this.records = {
      ...this.records,
      installs: { ...this.records.installs, [entry.manifest.id]: source.id },
    }
    this.save()
    this.deps.rescan()
    return this.ok()
  }

  uninstall(extId: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      if (typeof extId !== 'string' || !Object.hasOwn(this.records.installs, extId)) {
        return this.fail('not-installed')
      }
      const target = this.installDir(extId)
      if (existsSync(target) && !isRealDirectory(target)) return this.fail('conflict')
      try {
        rmSync(target, { recursive: true, force: true })
      } catch (err) {
        return this.fail('write-failed', (err as Error).message)
      }
      const { [extId]: _removed, ...installs } = this.records.installs
      this.records = { ...this.records, installs }
      this.save()
      this.deps.forget(extId)
      this.deps.rescan()
      return this.ok()
    })
  }
}
