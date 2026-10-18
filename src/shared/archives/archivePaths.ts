import { isCoreArchiveName } from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'

const ARCHIVE_SCHEME = 'archive:'

export interface ArchivePath {
  archive: string
  entry: string
}

export function isArchiveName(name: string, extra?: (name: string) => boolean): boolean {
  return isCoreArchiveName(name) || (extra?.(name) ?? false)
}

export function isArchivePath(path: string | undefined): boolean {
  return typeof path === 'string' && path.startsWith(ARCHIVE_SCHEME)
}

export function archiveRoot(realPath: string): string {
  return `${ARCHIVE_SCHEME}${encodeURIComponent(realPath).replace(/!/g, '%21')}!`
}

export function parseArchivePath(path: string): ArchivePath | null {
  if (!isArchivePath(path)) return null
  const rest = path.slice(ARCHIVE_SCHEME.length)
  const bang = rest.indexOf('!')
  if (bang <= 0) return null
  const after = rest.slice(bang + 1)
  if (after !== '' && !after.startsWith('/')) return null
  let archive: string
  try {
    archive = decodeURIComponent(rest.slice(0, bang))
  } catch {
    return null
  }
  if (!archive.startsWith('/')) return null
  return { archive, entry: after.replace(/^\/+/, '').replace(/\/+$/, '') }
}

export function archiveDisplayName(path: string): string | null {
  const parsed = parseArchivePath(path)
  if (!parsed) return null
  const name = parsed.archive.slice(parsed.archive.lastIndexOf('/') + 1)
  return parsed.entry ? `${name} › ${parsed.entry}` : name
}
