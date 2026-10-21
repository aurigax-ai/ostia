import type { ExtensionSettingValues } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import {
  goInstallArgs,
  isDownloadRun,
  isGoInstallRun,
  isNodeRun,
  type LanguageServerContribution,
  type LanguageServerFetchFailure,
  type LanguageServerInfo,
  type LanguageServerOverride,
  type LanguageServerOverrideProblem,
  type LanguageServerRun,
  type LanguageServerSandboxProblem,
  type LanguageServerStatus,
  type LspLogEntry,
  type LspStopReason,
  languageServerCommand,
  languageServerFeature,
  languageServerKey,
  languageServerKind,
  pathProgram,
  pinnedVersion,
} from '@aurigax-ai/ostia-extension-sdk/contract/languageServers'
import type { LogFields } from '../diagnostics/appLog'
import { overrideFileProblem } from './serverOverrides'
import type { Session } from './sessionProtocol'

const GO_PROGRAM = 'go'
const PROGRESS_STEP = 5

export interface LanguageServerSource {
  extId: string
  extName: string
  dir: string
  builtin: boolean
  state: 'on' | 'off' | 'pending'
  server: LanguageServerContribution
  settingValues: ExtensionSettingValues
  override?: LanguageServerOverride
}

export interface ManagedServerFiles {
  canFetch: (run: LanguageServerRun) => boolean
  executable: (extId: string, serverId: string, run: LanguageServerRun) => string | null
  folder: (extId: string, serverId: string, version: string) => string
  fetch: (
    extId: string,
    serverId: string,
    run: LanguageServerRun,
    hooks: { onProgress?: (percent: number) => void; onOutput?: (line: string) => void },
  ) => Promise<string>
  remove: (extId: string, serverId: string) => void
  retain: (keep: ReadonlyMap<string, string>) => void
}

export interface ServerRecord {
  entries: LspLogEntry[]
  errors: Map<string, number>
  sandboxProblem: { problem: LanguageServerSandboxProblem; detail: string } | null
  fetching: { percent: number; done: Promise<string | null> } | null
  fetchFailure: { reason: LanguageServerFetchFailure; detail: string } | null
  fetchHeld: boolean
}

interface Binary {
  path: string
  managedFolder: string | null
  override?: true
}

function failureOf(err: unknown): { reason: LanguageServerFetchFailure; detail: string } {
  const { reason, detail } = err as { reason?: LanguageServerFetchFailure; detail?: string }
  return typeof reason === 'string'
    ? { reason, detail: typeof detail === 'string' ? detail : '' }
    : { reason: 'write-failed', detail: '' }
}

interface ServerBinariesDeps {
  sources: () => LanguageServerSource[]
  findProgram: (program: string) => string | null
  managed: ManagedServerFiles
  overrideProblem?: (path: string) => LanguageServerOverrideProblem | null
  log?: (event: string, fields: LogFields) => void
  slots: ReadonlyMap<string, { crashed: boolean }>
  live: (key: string) => Session[]
  stop: (session: Session, reason: LspStopReason) => Promise<void>
  enabledSource: (key: unknown) => LanguageServerSource | undefined
  record: (key: string) => ServerRecord
  note: (key: string, entry: LspLogEntry) => void
  now: () => number
  changed: () => void
}

export class ServerBinaries {
  constructor(private readonly deps: ServerBinariesDeps) {}

  private managedCopy(source: LanguageServerSource): string | null {
    return this.deps.managed.executable(source.extId, source.server.id, source.server.run)
  }

  private fetchable(source: LanguageServerSource): boolean {
    const { run } = source.server
    if (isGoInstallRun(run)) return this.deps.findProgram(GO_PROGRAM) !== null
    return this.deps.managed.canFetch(run)
  }

  private overrideProblem(source: LanguageServerSource): LanguageServerOverrideProblem | null {
    if (!source.override) return null
    return (this.deps.overrideProblem ?? overrideFileProblem)(source.override.path)
  }

  private located(source: LanguageServerSource): Binary | null {
    const { run } = source.server
    if (source.override) {
      return this.overrideProblem(source) === null
        ? { path: source.override.path, managedFolder: null, override: true }
        : null
    }
    const program = pathProgram(run)
    if (program === null) return null
    const onPath = this.deps.findProgram(program)
    if (onPath !== null) return { path: onPath, managedFolder: null }
    const copy = this.managedCopy(source)
    const version = pinnedVersion(run)
    if (copy === null || version === null) return null
    return {
      path: copy,
      managedFolder: this.deps.managed.folder(source.extId, source.server.id, version),
    }
  }

  private status(source: LanguageServerSource, key: string): LanguageServerStatus {
    if (source.state === 'pending') return 'pending-approval'
    if (source.state === 'off') return 'off'
    const { run } = source.server
    const record = this.deps.record(key)
    if (this.overrideProblem(source) !== null) return 'override-invalid'
    if (!source.override && !isNodeRun(run) && this.located(source) === null) {
      if (record.fetching) return isGoInstallRun(run) ? 'installing' : 'downloading'
      if (record.fetchFailure) return isGoInstallRun(run) ? 'install-failed' : 'download-failed'
      if (!this.fetchable(source)) {
        return isGoInstallRun(run) ? 'toolchain-missing' : 'program-missing'
      }
      return 'idle'
    }
    if (this.deps.live(key).length > 0) return 'running'
    const prefix = `${key}\n`
    for (const [slotKey, slot] of this.deps.slots) {
      if (slot.crashed && slotKey.startsWith(prefix)) return 'crashed'
    }
    return record.sandboxProblem ? 'sandbox-unavailable' : 'idle'
  }

  servers(): LanguageServerInfo[] {
    return this.deps.sources().map((source) => {
      const key = languageServerKey(source.extId, source.server.id)
      const { run } = source.server
      const status = this.status(source, key)
      const record = this.deps.record(key)
      const sandbox = record.sandboxProblem
      const program = pathProgram(run)
      const version = pinnedVersion(run)
      const binary = source.state === 'on' ? this.located(source) : null
      const overrideProblem = this.overrideProblem(source)
      const needsInstall = status === 'program-missing' || status === 'toolchain-missing'
      const failed = status === 'download-failed' || status === 'install-failed'
      return {
        key,
        extId: source.extId,
        extName: source.extName,
        serverId: source.server.id,
        name: source.server.name,
        languages: source.server.languages,
        kind: languageServerKind(run),
        command: languageServerCommand(run),
        enabled: source.state === 'on',
        status,
        folders: new Set(this.deps.live(key).map((s) => s.root)).size,
        ...(program !== null ? { program } : {}),
        ...(needsInstall ? { requirement: languageServerFeature(key) } : {}),
        ...(version !== null ? { version } : {}),
        ...(binary
          ? {
              binary: binary.override
                ? { source: 'override' as const }
                : binary.managedFolder
                  ? { source: 'managed' as const, ...(version !== null ? { version } : {}) }
                  : { source: 'path' as const },
            }
          : {}),
        ...(source.override
          ? {
              override: {
                path: source.override.path,
                args: [...source.override.args],
                ...(overrideProblem !== null ? { problem: overrideProblem } : {}),
              },
            }
          : {}),
        ...(this.managedCopy(source) !== null ? { managedCopy: true } : {}),
        ...(source.state === 'on' && !source.override && !isNodeRun(run) && this.fetchable(source)
          ? { fetchable: true }
          : {}),
        ...(record.fetchHeld ? { fetchHeld: true } : {}),
        ...(record.fetching ? { progress: record.fetching.percent } : {}),
        ...(failed && record.fetchFailure
          ? { failure: record.fetchFailure.reason, failureDetail: record.fetchFailure.detail }
          : {}),
        ...(isGoInstallRun(run)
          ? { fetchCommand: [GO_PROGRAM, ...goInstallArgs(run.goInstall)].join(' ') }
          : {}),
        ...(status === 'sandbox-unavailable' && sandbox
          ? { sandboxProblem: sandbox.problem, sandboxDetail: sandbox.detail }
          : {}),
      }
    })
  }

  requiredProgram(run: LanguageServerRun): { program: string; package: string } | null {
    if (isNodeRun(run)) return null
    if (isGoInstallRun(run)) return { program: GO_PROGRAM, package: GO_PROGRAM }
    if (isDownloadRun(run)) {
      return this.deps.managed.canFetch(run)
        ? null
        : { program: run.download.program, package: run.download.program }
    }
    return { program: run.program, package: run.package ?? run.program }
  }

  private fetchNow(key: string, source: LanguageServerSource): Promise<string | null> {
    const record = this.deps.record(key)
    if (record.fetching) return record.fetching.done
    const { run } = source.server
    const version = pinnedVersion(run) ?? ''
    record.fetchFailure = null
    this.deps.note(key, {
      at: this.deps.now(),
      kind: 'fetch-start',
      how: isGoInstallRun(run) ? 'go-install' : 'download',
      version,
    })
    this.deps.log?.('lsp-fetch', { server: key, how: languageServerKind(run) })
    const state = { percent: 0, done: Promise.resolve<string | null>(null) }
    record.fetching = state
    state.done = this.deps.managed
      .fetch(source.extId, source.server.id, run, {
        onProgress: (percent) => {
          if (percent < state.percent + PROGRESS_STEP && percent < 100) return
          state.percent = percent
          this.deps.changed()
        },
        onOutput: (text) =>
          this.deps.note(key, { at: this.deps.now(), kind: 'fetch-output', text }),
      })
      .then(
        (path) => {
          this.deps.note(key, { at: this.deps.now(), kind: 'fetch-done', version })
          return path
        },
        (err: unknown) => {
          const failure = failureOf(err)
          record.fetchFailure = failure
          this.deps.note(key, { at: this.deps.now(), kind: 'fetch-failed', ...failure })
          this.deps.log?.('lsp-fetch-failed', { server: key, reason: failure.reason })
          return null
        },
      )
      .finally(() => {
        record.fetching = null
        this.deps.changed()
      })
    this.deps.changed()
    return state.done
  }

  async binaryFor(key: string, source: LanguageServerSource): Promise<Binary | null> {
    const found = this.located(source)
    if (found !== null) return found
    const record = this.deps.record(key)
    if (source.override) return null
    if (record.fetchFailure || record.fetchHeld || !this.fetchable(source)) return null
    await this.fetchNow(key, source)
    return this.located(source)
  }

  async fetch(key: unknown): Promise<void> {
    const source = this.deps.enabledSource(key)
    if (!source || typeof key !== 'string' || isNodeRun(source.server.run)) return
    if (source.override) return
    this.deps.record(key).fetchFailure = null
    this.deps.record(key).fetchHeld = false
    if (this.located(source) !== null || !this.fetchable(source)) {
      this.deps.changed()
      return
    }
    await this.fetchNow(key, source)
  }

  async removeDownload(key: unknown): Promise<void> {
    if (typeof key !== 'string') return
    const source = this.deps.sources().find((s) => languageServerKey(s.extId, s.server.id) === key)
    if (!source || this.deps.record(key).fetching) return
    await Promise.all(this.deps.live(key).map((session) => this.deps.stop(session, 'restart')))
    this.deps.managed.remove(source.extId, source.server.id)
    this.deps.record(key).fetchFailure = null
    this.deps.record(key).fetchHeld = true
    this.deps.note(key, { at: this.deps.now(), kind: 'fetch-removed' })
    this.deps.changed()
  }
}
