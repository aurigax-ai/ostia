import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { PANEL_SIZE_KEY, isFraction, parsePanelSizes, withPanelSize } from './split'

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
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.sizes, null, 2), { mode: 0o600 })
    renameSync(tmp, this.file)
  }
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
