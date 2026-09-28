import type { ExtensionResult } from '../../shared/extensions'

const params = new URLSearchParams(location.search)
const secret = params.get('t') ?? ''

export const context = {
  workDir: params.get('workDir') ?? '',
  sessionId: params.get('sessionId') ?? '',
  locale: params.get('locale') ?? 'en',
}

export async function call(command: string, args?: unknown): Promise<ExtensionResult> {
  try {
    const res = await fetch('/api', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-pine-panel': secret },
      body: JSON.stringify({ command, args: args ?? {}, context }),
    })
    return (await res.json()) as ExtensionResult
  } catch (err) {
    return {
      ok: false,
      error: 'unreachable',
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

export function onChange(cb: () => void): void {
  const events = new EventSource(`/events?t=${encodeURIComponent(secret)}`)
  events.onmessage = () => cb()
  window.addEventListener('focus', cb)
}

export function pickLocale<T>(dicts: { en: T } & Record<string, T>): T {
  if (context.locale.startsWith('zh') && dicts['zh-Hant']) return dicts['zh-Hant']
  return dicts[context.locale] ?? dicts.en
}

type Child = Node | string | null | false | undefined

export function h(
  tag: string,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...children: Child[]
): HTMLElement {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value)
    else if (value === true) el.setAttribute(key, '')
    else if (value !== false) el.setAttribute(key, value)
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    el.append(child)
  }
  return el
}

export function errorText(res: ExtensionResult): string {
  if (res.ok) return ''
  return res.message ? `${res.error}: ${res.message}` : res.error
}
