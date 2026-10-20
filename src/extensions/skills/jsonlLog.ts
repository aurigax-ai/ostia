import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export interface JsonlOptions<T> {
  dir: string | null
  file: string
  now: () => number
  retentionMs: number
  maxBytes: number
  parse: (line: string) => T | null
}

function lineOf(item: unknown): string {
  return `${JSON.stringify(item)}\n`
}

export class JsonlLog<T extends { at: number }> {
  private readonly path: string | null
  private items: T[] = []

  constructor(private readonly opts: JsonlOptions<T>) {
    this.path = opts.dir ? join(opts.dir, opts.file) : null
    if (this.path && existsSync(this.path)) {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean)
      this.items = lines.flatMap((line) => opts.parse(line) ?? [])
      if (this.prune() || this.items.length !== lines.length) this.rewrite()
    }
  }

  list(): T[] {
    if (this.prune()) this.rewrite()
    return [...this.items]
  }

  add(item: T): void {
    this.items.push(item)
    if (this.prune() || !this.append(item)) this.rewrite()
  }

  remove(match: (item: T) => boolean): boolean {
    const before = this.items.length
    this.items = this.items.filter((item) => !match(item))
    if (this.items.length === before) return false
    this.rewrite()
    return true
  }

  clear(): void {
    this.items = []
    if (this.path) rmSync(this.path, { force: true })
  }

  private prune(): boolean {
    const cutoff = this.opts.now() - this.opts.retentionMs
    const before = this.items.length
    this.items = this.items.filter((item) => item.at >= cutoff)
    let bytes = this.items.reduce((sum, item) => sum + Buffer.byteLength(lineOf(item)), 0)
    while (bytes > this.opts.maxBytes && this.items.length > 0) {
      bytes -= Buffer.byteLength(lineOf(this.items.shift()))
    }
    return this.items.length !== before
  }

  private append(item: T): boolean {
    if (!this.path || !this.opts.dir) return true
    try {
      mkdirSync(this.opts.dir, { recursive: true, mode: DIR_MODE })
      appendFileSync(this.path, lineOf(item), { mode: FILE_MODE })
      chmodSync(this.path, FILE_MODE)
      return true
    } catch {
      return false
    }
  }

  private rewrite(): void {
    if (!this.path) return
    writeFileAtomic(this.path, this.items.map(lineOf).join(''), {
      mode: FILE_MODE,
      dirMode: DIR_MODE,
    })
    chmodSync(this.path, FILE_MODE)
  }
}
