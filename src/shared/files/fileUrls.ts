import { type AppLinkMatch, findSchemeLinks } from '../common/externalLinks'
import { resolveLinkPath } from './fileLinks'

export type FileUrlOpener = 'html-page' | 'default-app'

export interface FileUrlTarget {
  path: string
  opener: FileUrlOpener
}

const PAGE_EXTENSIONS = new Set(['html', 'htm'])
const APP_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'drawio',
  'md',
  'txt',
  'csv',
  'json',
  'docx',
  'xlsx',
  'pptx',
])

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

function decoded(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return null
  }
}

export function fileUrlPath(url: string): string | null {
  const parsed = parse(url)
  if (parsed?.protocol !== 'file:' || (parsed.host !== '' && parsed.host !== 'localhost')) {
    return null
  }
  const path = decoded(parsed.pathname)
  if (!path?.startsWith('/') || path.includes('\0')) return null
  return resolveLinkPath(path, '/')
}

export function fileUrlOpener(path: string): FileUrlOpener | null {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return null
  const extension = name.slice(dot + 1).toLowerCase()
  if (PAGE_EXTENSIONS.has(extension)) return 'html-page'
  return APP_EXTENSIONS.has(extension) ? 'default-app' : null
}

export function opensFileUrl(url: string): boolean {
  const path = fileUrlPath(url)
  return path !== null && fileUrlOpener(path) !== null
}

export function findFileUrls(text: string): AppLinkMatch[] {
  return findSchemeLinks(text, opensFileUrl)
}
