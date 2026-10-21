import type { OfficialUpdateCheck } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { checkExtensionSignature } from '@aurigax-ai/ostia-extension-sdk/manifest/extensionSignature'
import type { RevokedVersion } from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { loadJson, saveJson } from '../platform/jsonStore'

function revocationKey(id: string, version: string): string {
  return `${id}@${version}`
}

export const OFFICIAL_REVOCATIONS_FILE = 'official-revocations.json'

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

export function officialUpdateCheck(
  publicKey: () => string | undefined,
  revocations: OfficialRevocations,
): OfficialUpdateCheck {
  return (dir, manifest) => {
    const signed = checkExtensionSignature(dir, manifest.id, manifest.version, publicKey())
    if (!signed.ok) return signed.problem
    return revocations.read().has(revocationKey(manifest.id, manifest.version))
      ? `version ${manifest.version} was revoked`
      : null
  }
}
