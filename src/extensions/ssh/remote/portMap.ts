import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'

type Saved = Record<string, Record<string, number>>

function read(file: string): Saved {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

export class PortMap {
  private readonly saved: Saved

  constructor(private readonly file: string | null) {
    this.saved = file ? read(file) : {}
  }

  get(host: string): Map<number, number> {
    return new Map(
      Object.entries(this.saved[host] ?? {}).map(([remote, local]) => [Number(remote), local]),
    )
  }

  set(host: string, remote: number, local: number): void {
    this.saved[host] = { ...this.saved[host], [remote]: local }
    this.save()
  }

  forget(host: string, remote: number): void {
    const { [remote]: _gone, ...rest } = this.saved[host] ?? {}
    this.saved[host] = rest
    this.save()
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(this.file, `${JSON.stringify(this.saved, null, 2)}\n`, {
      mode: 0o600,
      dirMode: 0o700,
    })
  }
}
