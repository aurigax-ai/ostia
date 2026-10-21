import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  EXTENSION_MANIFEST_FILE,
  type ExtensionManifest,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { isRecord } from '@aurigax-ai/ostia-extension-sdk/contract/isRecord'
import { agentSkillProblems } from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import {
  type OfficialUpdateCheck,
  readManifest,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  isNewerVersion,
  isPrerelease,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionVersions'
import {
  loadLocaleCatalogs,
  manifestIn,
} from '@aurigax-ai/ostia-extension-sdk/manifest/localeCatalogs'
import { EXTENSION_ID_PATTERN } from '@aurigax-ai/ostia-extension-sdk/manifest/manifestFields'
import {
  MARKETPLACE_CODE_PATTERN,
  planCopy,
  type RevokedVersion,
} from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import {
  MARKETPLACE_FEATURE,
  type MarketplaceError,
  type MarketplaceExtension,
  type MarketplaceFound,
  type MarketplaceInfo,
  type MarketplaceInstallState,
  type MarketplaceResult,
  type MarketplaceState,
} from '../../../shared/extensions/marketplace'
import { loadJson, saveJson } from '../../platform/jsonStore'
import { missingRequirements } from '../../platform/systemRequirements'
import { type Catalog, type CatalogEntry, isRealDirectory, readCatalog } from './marketplaceCatalog'
import { stageDevSource } from './marketplaceDev'
import {
  GitError,
  type GitRunner,
  marketplaceId,
  normalizeMarketplaceUrl,
  runGit,
} from './marketplaceSources'

const DETAIL_MAX = 400

interface Source {
  id: string
  url: string
}

const DEV_OWNER = 'dev'

interface Records {
  sources: Source[]
  installs: Record<string, string>
  prerelease: string[]
  dev: Record<string, string>
}

function sanitizeRecords(raw: unknown): Records {
  const records: Records = { sources: [], installs: {}, prerelease: [], dev: {} }
  if (typeof raw !== 'object' || raw === null) return records
  const { sources, installs, prerelease, dev } = raw as {
    sources?: unknown
    installs?: unknown
    prerelease?: unknown
    dev?: unknown
  }
  if (Array.isArray(sources)) {
    for (const source of sources) {
      const url = normalizeMarketplaceUrl((source as { url?: unknown } | null)?.url)
      if (!url) continue
      if (!records.sources.some((s) => s.url === url)) {
        records.sources.push({ id: marketplaceId(url), url })
      }
    }
  }
  if (isRecord(installs)) {
    for (const [extId, source] of Object.entries(installs)) {
      if (EXTENSION_ID_PATTERN.test(extId) && typeof source === 'string') {
        records.installs[extId] = source
      }
    }
  }
  if (Array.isArray(prerelease)) {
    records.prerelease = prerelease.filter(
      (extId): extId is string => typeof extId === 'string' && EXTENSION_ID_PATTERN.test(extId),
    )
  }
  if (isRecord(dev)) {
    for (const [extId, source] of Object.entries(dev)) {
      if (records.installs[extId] === DEV_OWNER && typeof source === 'string') {
        records.dev[extId] = source
      }
    }
  }
  return records
}

export interface MarketplaceDeps {
  recordsPath: string
  clonesDir: string
  extensionsDir: string
  bundled: (extId: string) => ExtensionManifest | undefined
  disable: (extId: string) => void
  officialUpdate: OfficialUpdateCheck
  saveRevocations: (revoked: readonly RevokedVersion[]) => boolean
  forget: (extId: string) => void
  rescan: () => void
  locale?: () => string | undefined
  official?: string
  git?: GitRunner
  gitMissing?: () => boolean
}

function clip(text: string): string {
  return text.trim().slice(0, DETAIL_MAX)
}

export interface ExtensionListing {
  marketplaceId: string
  extId: string
  name: string
  languages: string[]
  patterns: string[]
  browsePatterns: string[]
}

function patternsOf(
  manifest: ExtensionManifest,
  pick: (kind: NonNullable<ExtensionManifest['contributes']['fileKinds']>[number]) => boolean,
): string[] {
  return (manifest.contributes.fileKinds ?? [])
    .filter(pick)
    .flatMap((kind) => kind.selector.map((item) => item.filenamePattern))
}

export class Marketplace {
  private records: Records
  private queue: Promise<unknown> = Promise.resolve()
  private listed: ExtensionListing[] | null = null
  private readonly officialUrl: string | null

  constructor(private readonly deps: MarketplaceDeps) {
    this.records = sanitizeRecords(loadJson<unknown>(deps.recordsPath, {}))
    this.officialUrl = normalizeMarketplaceUrl(deps.official)
    const official = this.officialUrl
    if (official && !this.records.sources.some((s) => s.url === official)) {
      this.records.sources.unshift({ id: marketplaceId(official), url: official })
    }
  }

  private save(): void {
    this.listed = null
    saveJson(this.deps.recordsPath, this.records)
  }

  listings(): ExtensionListing[] {
    if (this.listed) return this.listed
    const listed: ExtensionListing[] = []
    for (const source of this.records.sources) {
      const dir = this.cloneDir(source.id)
      const catalog = existsSync(dir) ? this.catalogOf(dir) : null
      if (catalog === null || typeof catalog === 'string') continue
      for (const entry of catalog.entries) {
        if (!this.isShown(source.id, entry)) continue
        const { manifest } = entry
        const languages = (manifest.contributes.languageServers ?? []).flatMap((s) => s.languages)
        const state = this.installState(source.id, entry)
        if (state === 'conflict' || state === 'incompatible') continue
        listed.push({
          marketplaceId: source.id,
          extId: manifest.id,
          name: manifest.name,
          languages: [...new Set(languages)],
          patterns: patternsOf(manifest, (kind) => Boolean(kind.view)),
          browsePatterns: patternsOf(manifest, (kind) => !kind.view && Boolean(kind.browse)),
        })
      }
    }
    this.listed = listed
    return listed
  }

  private catalogOf(dir: string): Catalog | string {
    return readCatalog(dir, { prerelease: (extId) => this.records.prerelease.includes(extId) })
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

  private installState(sourceId: string, entry: CatalogEntry): MarketplaceInstallState {
    const { manifest } = entry
    const bundled = this.deps.bundled(manifest.id)
    if (bundled !== undefined && !this.canUpdateBuiltin(sourceId, entry, bundled)) return 'conflict'
    if (entry.needsApi) return 'incompatible'
    if (!existsSync(this.installDir(manifest.id))) return 'available'
    const owner = this.records.installs[manifest.id]
    if (owner === sourceId) {
      const installed = this.installedVersion(manifest.id)
      if (installed === undefined || isNewerVersion(manifest.version, installed)) return 'update'
      return this.leavesPrerelease(manifest, installed) ? 'update' : 'installed'
    }
    return owner !== undefined && owner !== DEV_OWNER && !this.hasSource(owner)
      ? 'replace'
      : 'conflict'
  }

  private isBundled(entry: CatalogEntry): boolean {
    return this.deps.bundled(entry.manifest.id) !== undefined
  }

  private leavesPrerelease(manifest: ExtensionManifest, installed: string): boolean {
    return (
      manifest.version !== installed &&
      isPrerelease(installed) &&
      !isPrerelease(manifest.version) &&
      !this.records.prerelease.includes(manifest.id)
    )
  }

  private isDowngrade(entry: CatalogEntry): boolean {
    const installed = this.installedVersion(entry.manifest.id)
    return installed !== undefined && !isNewerVersion(entry.manifest.version, installed)
  }

  private canUpdateBuiltin(
    sourceId: string,
    entry: CatalogEntry,
    bundled: ExtensionManifest,
  ): boolean {
    const source = this.records.sources.find((s) => s.id === sourceId)
    if (!source || source.url !== this.officialUrl) return false
    if (!isNewerVersion(entry.manifest.version, bundled.version)) return false
    return this.deps.officialUpdate(entry.dir, entry.manifest, bundled) === null
  }

  private hasSource(id: string): boolean {
    return this.records.sources.some((source) => source.id === id)
  }

  private isShown(sourceId: string, entry: CatalogEntry): boolean {
    if (!entry.code) return true
    const { id } = entry.manifest
    return this.records.installs[id] === sourceId && existsSync(this.installDir(id))
  }

  private describe(
    source: Source,
    entry: CatalogEntry,
    locale: string | undefined,
    catalog: Catalog,
  ): MarketplaceExtension {
    const { dir, manifest } = entry
    const state = this.installState(source.id, entry)
    const installed =
      this.records.installs[manifest.id] === source.id
        ? this.installedVersion(manifest.id)
        : undefined
    const installedVersion = state === 'update' ? installed : undefined
    const downgrade = state === 'update' && this.isDowngrade(entry)
    const installedRevoked = catalog.revoked.some(
      (r) => r.id === manifest.id && r.version === installed,
    )
    const shown = manifestIn(manifest, loadLocaleCatalogs(dir, manifest), locale)
    const icon = manifest.contributes.panel?.icon ?? manifest.contributes.settingsPage?.icon
    const commandTitle = (id: string): string =>
      shown.contributes.commands.find((c) => c.id === id)?.title ?? id
    return {
      id: manifest.id,
      name: shown.name,
      version: manifest.version,
      description: shown.description,
      category: manifest.category,
      ...(icon ? { icon } : {}),
      capabilities: manifest.capabilities,
      runsProcess:
        manifest.main !== undefined || (manifest.contributes.languageServers ?? []).length > 0,
      agentSkills: (manifest.contributes.agentSkills ?? []).map((skill) => skill.name),
      agentHooks: (manifest.contributes.agentHooks ?? []).map((hook) => ({
        event: hook.event,
        command: commandTitle(hook.command),
      })),
      state,
      ...(installedVersion ? { installedVersion } : {}),
      ...(installedRevoked ? { installedRevoked } : {}),
      ...(downgrade ? { downgrade } : {}),
      ...(entry.needsApi ? { needsApi: entry.needsApi } : {}),
    }
  }

  private info(source: Source): MarketplaceInfo {
    const installs = Object.entries(this.records.installs)
      .filter(([extId, owner]) => owner === source.id && existsSync(this.installDir(extId)))
      .map(([extId]) => extId)
    const downloaded = existsSync(this.cloneDir(source.id))
    const official = source.url === this.officialUrl
    const base = { id: source.id, url: source.url, installs, official, downloaded }
    const locale = this.deps.locale?.()
    const catalog = downloaded ? this.catalogOf(this.cloneDir(source.id)) : null
    if (catalog === null || typeof catalog === 'string') {
      return {
        ...base,
        name: source.url,
        description: '',
        ...(catalog === null ? {} : { error: catalog }),
        problems: [],
        extensions: [],
        unlisted: false,
      }
    }
    const offered = catalog.entries.filter((entry) => this.isShown(source.id, entry))
    return {
      ...base,
      name: catalog.name,
      description: catalog.description,
      problems: catalog.problems,
      unlisted: catalog.unlisted,
      extensions: offered.map((entry) => this.describe(source, entry, locale, catalog)),
    }
  }

  state(): MarketplaceState {
    return {
      marketplaces: this.records.sources.map((source) => this.info(source)),
      installed: Object.keys(this.records.installs).filter((id) => existsSync(this.installDir(id))),
      prerelease: this.records.prerelease,
      dev: this.records.dev,
    }
  }

  syncedInstalls(): { id: string; marketplace: string }[] {
    return Object.entries(this.records.installs).flatMap(([id, owner]) => {
      const source = this.records.sources.find((s) => s.id === owner)
      return source && existsSync(this.installDir(id)) ? [{ id, marketplace: source.url }] : []
    })
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
    const catalog = this.catalogOf(staging)
    if (typeof catalog === 'string') {
      rmSync(staging, { recursive: true, force: true })
      return this.fail('invalid-marketplace', catalog)
    }
    rmSync(target, { recursive: true, force: true })
    renameSync(staging, target)
    this.listed = null
    if (source.url === this.officialUrl && this.deps.saveRevocations(catalog.revoked)) {
      this.deps.rescan()
    }
    this.stopRevoked(source.id, catalog)
    return null
  }

  private stopRevoked(sourceId: string, catalog: Catalog): void {
    for (const [extId, owner] of Object.entries(this.records.installs)) {
      if (owner !== sourceId || this.deps.bundled(extId) !== undefined) continue
      const installed = this.installedVersion(extId)
      if (catalog.revoked.some((r) => r.id === extId && r.version === installed)) {
        this.deps.disable(extId)
      }
    }
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
      const catalog = existsSync(dir) ? this.catalogOf(dir) : null
      if (catalog === null || typeof catalog === 'string') return false
      const entry = catalog.entries.find(
        (e) => e.manifest.id === extId && this.isShown(source.id, e),
      )
      return entry !== undefined && this.installState(source.id, entry) !== 'conflict'
    })
  }

  private listedAnywhere(extId: string, onlyUrl: string | null): boolean {
    return this.records.sources.some((source) => {
      if (onlyUrl !== null && source.url !== onlyUrl) return false
      const dir = this.cloneDir(source.id)
      const catalog = existsSync(dir) ? this.catalogOf(dir) : null
      if (catalog === null || typeof catalog === 'string') return false
      return catalog.entries.some((e) => e.manifest.id === extId && this.isShown(source.id, e))
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
        if (!official) return this.fail('unknown-extension')
        const known = this.records.sources.find((s) => s.url === official)
        if (known && existsSync(this.cloneDir(known.id))) {
          return this.fail(this.listedAnywhere(extId, only) ? 'conflict' : 'unknown-extension')
        }
        const added = known
          ? ((await this.download(known)) ?? this.ok())
          : await this.addSource(official)
        if (!added.ok) return added
        source = this.sourceListing(extId, only)
        if (!source) return this.fail('unknown-extension')
      }
      return this.installFrom(source.id, this.shownEntry(extId))
    })
  }

  refresh(id: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      const source = this.records.sources.find((s) => s.id === id)
      if (!source) return this.fail('unknown-marketplace')
      return (await this.download(source)) ?? this.ok()
    })
  }

  remove(id: unknown, uninstallExtensions: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      const source = this.records.sources.find((s) => s.id === id)
      if (!source) return this.fail('unknown-marketplace')
      if (source.url === this.officialUrl) return this.fail('official-marketplace')
      if (uninstallExtensions === true) {
        for (const [extId, owner] of Object.entries(this.records.installs)) {
          if (owner !== source.id) continue
          const failure = this.removeInstall(extId)
          if (failure) return failure
        }
      }
      rmSync(this.cloneDir(source.id), { recursive: true, force: true })
      this.records = {
        ...this.records,
        sources: this.records.sources.filter((s) => s.id !== source.id),
      }
      this.save()
      this.deps.rescan()
      return this.ok()
    })
  }

  private async installFrom(
    id: unknown,
    pick: (source: Source, catalog: Catalog) => CatalogEntry | MarketplaceResult,
    confirmDowngrade = false,
  ): Promise<MarketplaceResult> {
    const source = this.records.sources.find((s) => s.id === id)
    if (!source) return this.fail('unknown-marketplace')
    const catalog = this.catalogOf(this.cloneDir(source.id))
    if (typeof catalog === 'string') return this.fail('invalid-marketplace', catalog)
    const entry = pick(source, catalog)
    if ('ok' in entry) return entry
    const state = this.installState(source.id, entry)
    if (state === 'conflict') return this.fail('conflict')
    if (state === 'incompatible') return this.fail('needs-newer-app', entry.needsApi)
    if (state === 'update' && !confirmDowngrade && this.isDowngrade(entry)) {
      return this.fail('downgrade-unconfirmed')
    }
    const fresh = (state === 'available' || state === 'replace') && !this.isBundled(entry)
    return this.place(entry, source.id, fresh)
  }

  private place(
    entry: CatalogEntry,
    owner: string,
    fresh: boolean,
    note?: string,
  ): MarketplaceResult {
    const plan = planCopy(entry.dir)
    if (!plan.ok) return this.fail(plan.error)
    const target = this.installDir(entry.manifest.id)
    try {
      if (fresh) this.deps.forget(entry.manifest.id)
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
    const { [entry.manifest.id]: _dev, ...dev } = this.records.dev
    this.records = {
      ...this.records,
      installs: { ...this.records.installs, [entry.manifest.id]: owner },
      dev: note ? { ...dev, [entry.manifest.id]: note } : dev,
    }
    this.save()
    this.deps.rescan()
    return this.ok()
  }

  installDev(input: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      mkdirSync(this.deps.clonesDir, { recursive: true })
      if (this.gitMissing() && (input as { kind?: unknown } | null)?.kind === 'git') {
        return this.fail('git-missing')
      }
      const staged = await stageDevSource(input, this.deps.clonesDir, this.deps.git)
      if (!staged.ok) return this.fail(staged.error, staged.detail)
      try {
        const res = readManifest(staged.dir)
        if (!res.ok) return this.fail('invalid-extension', res.error)
        const problems = agentSkillProblems(staged.dir, res.manifest)
        if (problems.length > 0) return this.fail('invalid-extension', problems.join('; '))
        const { id } = res.manifest
        const owner = this.records.installs[id]
        const taken = existsSync(this.installDir(id)) && owner !== DEV_OWNER
        if (this.deps.bundled(id) !== undefined || taken) return this.fail('conflict')
        const entry = { dir: staged.dir, manifest: res.manifest }
        const same = existsSync(this.installDir(id)) && this.records.dev[id] === staged.label
        return this.place(entry, DEV_OWNER, !same, staged.label)
      } finally {
        staged.cleanup()
      }
    })
  }

  private shownEntry(extId: unknown) {
    return (source: Source, catalog: Catalog): CatalogEntry | MarketplaceResult =>
      catalog.entries.find((e) => e.manifest.id === extId && this.isShown(source.id, e)) ??
      this.fail('unknown-extension')
  }

  install(id: unknown, extId: unknown, confirmDowngrade?: unknown): Promise<MarketplaceResult> {
    return this.serialized(() =>
      this.installFrom(id, this.shownEntry(extId), confirmDowngrade === true),
    )
  }

  findCode(input: unknown): MarketplaceFound {
    const code = typeof input === 'string' ? input.trim() : ''
    if (!MARKETPLACE_CODE_PATTERN.test(code)) return { ok: false, error: 'unknown-code' }
    for (const source of this.records.sources) {
      const dir = this.cloneDir(source.id)
      const catalog = existsSync(dir) ? this.catalogOf(dir) : null
      if (catalog === null || typeof catalog === 'string') continue
      const broken = catalog.brokenUnlisted.find((b) => b.code === code)
      if (broken) return { ok: false, error: 'invalid-extension', detail: broken.problem }
      const entry = catalog.entries.find((e) => e.code === code)
      if (entry) {
        const extension = this.describe(source, entry, this.deps.locale?.(), catalog)
        return { ok: true, marketplaceId: source.id, extension }
      }
    }
    return { ok: false, error: 'unknown-code' }
  }

  installCode(id: unknown, input: unknown): Promise<MarketplaceResult> {
    return this.serialized(() =>
      this.installFrom(id, (_source, catalog) => {
        const code = typeof input === 'string' ? input.trim() : ''
        if (!MARKETPLACE_CODE_PATTERN.test(code)) return this.fail('unknown-code')
        const broken = catalog.brokenUnlisted.find((b) => b.code === code)
        if (broken) return this.fail('invalid-extension', broken.problem)
        return catalog.entries.find((e) => e.code === code) ?? this.fail('unknown-code')
      }),
    )
  }

  setPrerelease(extId: unknown, enabled: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      if (typeof extId !== 'string' || !EXTENSION_ID_PATTERN.test(extId)) {
        return this.fail('unknown-extension')
      }
      const others = this.records.prerelease.filter((id) => id !== extId)
      this.records = { ...this.records, prerelease: enabled === true ? [...others, extId] : others }
      this.save()
      return this.ok()
    })
  }

  uninstall(extId: unknown): Promise<MarketplaceResult> {
    return this.serialized(async () => {
      if (typeof extId !== 'string' || !Object.hasOwn(this.records.installs, extId)) {
        return this.fail('not-installed')
      }
      const failure = this.removeInstall(extId)
      if (failure) return failure
      this.save()
      this.deps.rescan()
      return this.ok()
    })
  }

  private removeInstall(extId: string): MarketplaceResult | null {
    const target = this.installDir(extId)
    if (existsSync(target) && !isRealDirectory(target)) return this.fail('conflict')
    try {
      rmSync(target, { recursive: true, force: true })
    } catch (err) {
      return this.fail('write-failed', (err as Error).message)
    }
    const { [extId]: _removed, ...installs } = this.records.installs
    const { [extId]: _dev, ...dev } = this.records.dev
    this.records = { ...this.records, installs, dev }
    if (this.deps.bundled(extId) === undefined) this.deps.forget(extId)
    return null
  }
}
