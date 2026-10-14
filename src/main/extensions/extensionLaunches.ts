import { loadJson, saveJson } from '../platform/jsonStore'
import { EXTENSION_ID_PATTERN } from './extensionManifest'

const MAX_IDS = 64

function sanitize(raw: unknown): Set<string> {
  if (!Array.isArray(raw)) return new Set()
  return new Set(
    raw
      .filter((id): id is string => typeof id === 'string' && EXTENSION_ID_PATTERN.test(id))
      .slice(0, MAX_IDS),
  )
}

export class ExtensionLaunches {
  private ids: Set<string>

  constructor(private readonly path: string) {
    this.ids = sanitize(loadJson<unknown>(path, []))
  }

  has(id: string): boolean {
    return this.ids.has(id)
  }

  set(id: string, on: boolean): void {
    if (on === this.ids.has(id) || !EXTENSION_ID_PATTERN.test(id)) return
    if (on && this.ids.size >= MAX_IDS) return
    if (on) this.ids.add(id)
    else this.ids.delete(id)
    saveJson(this.path, [...this.ids].sort())
  }
}
