import { type BrowserSettings, searchUrl } from '@shared/browserEditorSettings'

export function resolveAddress(input: string, settings: BrowserSettings): string {
  const trimmed = input.trim()
  if (!trimmed) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed
  if (!trimmed.includes(' ') && trimmed.includes('.')) return `https://${trimmed}`
  return searchUrl(settings, trimmed)
}
