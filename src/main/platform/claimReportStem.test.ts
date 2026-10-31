import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claimReportStem } from './claimReportStem'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claim-stem-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('claimReportStem', () => {
  it('reserves the stem it names by creating its report file', () => {
    const stem = claimReportStem(dir, () => 'capture-1')
    expect(stem).toBe(join(dir, 'capture-1'))
    expect(readdirSync(dir)).toEqual(['capture-1.md'])
  })

  it('asks again when another process took the stem between listing and creating', () => {
    const seen: Array<readonly string[]> = []
    const stem = claimReportStem(dir, (names) => {
      seen.push(names)
      if (seen.length === 1) writeFileSync(join(dir, 'capture-1.md'), 'theirs')
      return `capture-${names.filter((name) => name.endsWith('.md')).length + 1}`
    })
    expect(stem).toBe(join(dir, 'capture-2'))
    expect(seen).toHaveLength(2)
  })

  it('lets any other failure through', () => {
    expect(() => claimReportStem(join(dir, 'missing'), () => 'capture-1')).toThrow()
  })
})
