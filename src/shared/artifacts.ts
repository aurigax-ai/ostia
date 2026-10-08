export const ARTIFACTS_ENV = 'ARTIFACTS'
export const PAD_ENV = 'PAD'
export const PAD_FILE = 'PAD.md'
export const PAD_MAX_BYTES = 256 * 1024
export const PAD_SAVE_DELAY_MS = 1000
export const PAD_COMMAND = 'workspace.openPad'
export const ARTIFACT_LIST_MAX = 200
export const ARTIFACT_FILE_MAX_BYTES = 16 * 1024 * 1024
export const ARTIFACT_KEEP_CLOSED_MS = 14 * 24 * 60 * 60 * 1000

export interface ArtifactEntry {
  name: string
  path: string
  size: number
  modified: number
}

export interface ArtifactListing {
  dir: string
  pad: string
  padModified: number | null
  entries: ArtifactEntry[]
}

export function isInside(dir: string | null | undefined, path: string | null | undefined): boolean {
  return Boolean(dir && path?.startsWith(`${dir}/`))
}

export function isPadPath(listing: Pick<ArtifactListing, 'pad'> | null, path: string | undefined) {
  return Boolean(listing && path === listing.pad)
}

export function changedArtifacts(
  before: readonly ArtifactEntry[],
  after: readonly ArtifactEntry[],
): string[] {
  const known = new Map(before.map((entry) => [entry.path, entry.modified]))
  return after
    .filter((entry) => {
      const seen = known.get(entry.path)
      return seen === undefined || entry.modified > seen
    })
    .map((entry) => entry.path)
}

export function exceedsPad(text: string): boolean {
  if (text.length > PAD_MAX_BYTES) return true
  if (text.length * 3 <= PAD_MAX_BYTES) return false
  return new TextEncoder().encode(text).length > PAD_MAX_BYTES
}
