import { builtinUpdateProblem } from '@aurigax-ai/ostia-extension-sdk/manifest/builtinUpdate'
import type { OfficialUpdateCheck } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import {
  checkExtensionSignatureAsync,
  extensionStamp,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionSignature'
import {
  isNewerVersion,
  isOlderVersion,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionVersions'
import type { RevokedVersion } from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { loadJson, saveJson } from '../platform/jsonStore'
import officialKey from './officialKey.json'

export const OFFICIAL_REVOCATIONS_FILE = 'official-revocations.json'
export const OFFICIAL_VERSIONS_FILE = 'official-versions.json'

export const UPDATABLE_BUILTINS: readonly string[] = [
  'csv',
  'images',
  'keymap-macos',
  'markdown',
  'office',
  'pdf',
  'serial',
  'ssh',
  'system',
  'video',
]

export const OFFICIAL_EXTENSION_PUBLIC_KEY: string = officialKey.publicKey

function revocationKey(id: string, version: string): string {
  return `${id}@${version}`
}

export class OfficialRevocations {
  constructor(private readonly path: string) {}

  read(): Set<string> {
    const stored = loadJson<unknown>(this.path, [])
    const list = Array.isArray(stored) ? stored : []
    return new Set(list.filter((entry): entry is string => typeof entry === 'string'))
  }

  replace(revoked: readonly RevokedVersion[]): boolean {
    const next = revoked.map((entry) => revocationKey(entry.id, entry.version)).sort()
    const before = [...this.read()].sort()
    if (next.length === before.length && next.every((key, i) => key === before[i])) return false
    saveJson(this.path, next)
    return true
  }
}

export class AcceptedVersions {
  constructor(private readonly path: string) {}

  private read(): Record<string, string> {
    const stored = loadJson<unknown>(this.path, {})
    if (typeof stored !== 'object' || stored === null) return {}
    return Object.fromEntries(
      Object.entries(stored).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
  }

  highest(id: string): string | undefined {
    return this.read()[id]
  }

  record(id: string, version: string): void {
    const known = this.highest(id)
    if (known !== undefined && !isNewerVersion(version, known)) return
    saveJson(this.path, { ...this.read(), [id]: version }, { secure: true })
  }
}

interface Verdict {
  stamp: string
  problem: string | null
}

export interface OfficialVerifierDeps {
  publicKey: () => string | undefined
  revocations: OfficialRevocations
  accepted: AcceptedVersions
  onVerified: () => void
  updatable?: readonly string[]
}

export class OfficialVerifier {
  private readonly verdicts = new Map<string, Verdict>()
  private readonly pending = new Map<string, Promise<void>>()

  constructor(private readonly deps: OfficialVerifierDeps) {}

  readonly check: OfficialUpdateCheck = (dir, manifest, bundled) => {
    const { id, version } = manifest
    if (!(this.deps.updatable ?? UPDATABLE_BUILTINS).includes(id))
      return `${id} stays tied to the app`
    const known = this.deps.accepted.highest(id)
    if (known !== undefined && isOlderVersion(version, known)) {
      return `version ${version} is below ${known}, which was already accepted`
    }
    if (this.deps.revocations.read().has(revocationKey(id, version))) {
      return `version ${version} was revoked`
    }
    const claims = builtinUpdateProblem(bundled, manifest)
    if (claims) return claims
    const stamp = extensionStamp(dir)
    if (stamp === null) return 'holds a link or special file'
    const key = `${dir}\0${id}\0${version}\0${this.deps.publicKey() ?? ''}`
    const verdict = this.verdicts.get(key)
    if (verdict?.stamp === stamp) return verdict.problem
    this.verify(key, dir, id, version, stamp)
    return 'is being verified'
  }

  private verify(key: string, dir: string, id: string, version: string, stamp: string): void {
    if (this.pending.has(key)) return
    const run = checkExtensionSignatureAsync(dir, id, version, this.deps.publicKey())
      .then((res) => {
        this.verdicts.set(key, { stamp, problem: res.ok ? null : res.problem })
        if (res.ok) this.deps.accepted.record(id, version)
      })
      .catch((err: unknown) => {
        this.verdicts.set(key, { stamp, problem: (err as Error).message })
      })
      .finally(() => {
        this.pending.delete(key)
        this.deps.onVerified()
      })
    this.pending.set(key, run)
  }

  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending.values()])
  }
}
