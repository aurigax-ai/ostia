import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export function bz2(name: string): Buffer {
  return readFileSync(join(__dirname, 'bz2', name))
}
