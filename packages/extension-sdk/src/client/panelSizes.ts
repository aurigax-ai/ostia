import { readFileSync } from 'node:fs'
import { writeFileAtomic } from './atomicWrite'
import { isFraction, PANEL_SIZE_KEY, parsePanelSizes, withPanelSize } from './split'

export const PANEL_SIZES_FILE = 'panel-sizes.json'

export class PanelSizeStore {
  private sizes: Record<string, number>

  constructor(private readonly file: string | null) {
    this.sizes = parsePanelSizes(file ? readJson(file) : null)
  }

  all(): Record<string, number> {
    return { ...this.sizes }
  }

  set(key: unknown, fraction: unknown): boolean {
    if (typeof key !== 'string' || !PANEL_SIZE_KEY.test(key)) return false
    if (fraction !== null && !isFraction(fraction)) return false
    this.sizes = withPanelSize(this.sizes, key, fraction)
    this.save()
    return true
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(this.file, JSON.stringify(this.sizes, null, 2), { mode: 0o600, dirMode: 0o700 })
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
