/// <reference lib="dom" />
import type { BrowseFail } from '../browser/browseRuntime'

const MAX_NAME = 200
export const SKIP_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'head',
  'meta',
  'link',
])

export const fail = (error: string, message?: string): BrowseFail =>
  message ? { ok: false, error, message } : { ok: false, error }

export const collapse = (text: string | null | undefined): string =>
  (text ?? '').replace(/\s+/g, ' ').trim()

export const clipName = (text: string): string =>
  text.length > MAX_NAME ? `${text.slice(0, MAX_NAME - 1)}…` : text

export const textOf = (el: Element): string =>
  collapse((el as HTMLElement).innerText ?? el.textContent ?? '')

export const describeElement = (el: Element): string => {
  const id = el.id ? `#${el.id}` : ''
  const cls =
    typeof el.className === 'string' && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}`
      : ''
  return `<${el.tagName.toLowerCase()}${id}${cls}>`
}
