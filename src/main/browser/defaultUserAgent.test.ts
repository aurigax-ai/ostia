import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const MAIN_DIR = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []
  })
}

describe('browser user agent', () => {
  it('keeps the Electron default for every browser session', () => {
    const rewriting = sources(MAIN_DIR).filter((file) =>
      /\bsetUserAgent\s*\(|UserAgentOverride/.test(readFileSync(file, 'utf8')),
    )
    expect(rewriting).toEqual([])
  })
})
