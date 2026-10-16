import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './affectedTests.mjs'

const SHEETJS = {
  version: '0.20.3',
  tarball: 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz',
  integrity:
    'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==',
  vault: 'architecture/office-viewers',
}

const CHANGED = `SheetJS is pinned outside npm, so Dependabot and dependency-review cannot see its advisories. Check https://cdn.sheetjs.com and its advisories, update the "SheetJS pin" section of vault ${SHEETJS.vault}, then update SHEETJS here.`

describe('the SheetJS pin', () => {
  it('stays the reviewed tarball, by URL and integrity', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      devDependencies: Record<string, string>
    }
    const lock = readFileSync(join(ROOT, 'pnpm-lock.yaml'), 'utf8')
    const resolution = new RegExp(
      `^  xlsx@${SHEETJS.tarball.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\n    resolution: \\{integrity: ([^,]+), tarball: ([^}]+)\\}`,
      'm',
    ).exec(lock)
    expect(manifest.devDependencies.xlsx, CHANGED).toBe(SHEETJS.tarball)
    expect(resolution?.slice(1), CHANGED).toEqual([SHEETJS.integrity, SHEETJS.tarball])
    expect(lock.match(/^ {2}xlsx@/gm), CHANGED).toHaveLength(2)
  })

  it('is the version installed', () => {
    const installed = JSON.parse(
      readFileSync(join(ROOT, 'node_modules/xlsx/package.json'), 'utf8'),
    ) as { version: string }
    expect(installed.version, CHANGED).toBe(SHEETJS.version)
  })
})
