import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const E2E = join(process.cwd(), 'e2e')
const PLAYWRIGHT_IMPORT = /from '@playwright\/test'/
const CORE_MARK = /@core\b/g
const DESCRIBE_WITH_CORE =
  /\.describe(?:\.\w+)?\(\s*(?:(['"`])[^\n]*?@core|(['"`])[^\n]*?\2\s*,\s*\{[^}]*@core)/

function specSources(): { name: string; source: string }[] {
  return readdirSync(E2E)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => ({ name, source: readFileSync(join(E2E, name), 'utf8') }))
}

describe('e2e imports', () => {
  it('takes Playwright only through e2e/test.ts, which keeps the app trace of a failing test', () => {
    const direct = readdirSync(E2E)
      .filter((name) => name.endsWith('.ts') && name !== 'test.ts')
      .filter((name) => PLAYWRIGHT_IMPORT.test(readFileSync(join(E2E, name), 'utf8')))
    expect(direct).toEqual([])
  })

  it('marks at most 34 e2e tests @core, so the merge queue runs a small set', () => {
    const marks = specSources().flatMap(({ source }) => source.match(CORE_MARK) ?? [])
    expect(marks.length).toBeLessThanOrEqual(34)
  })

  it('never puts @core on a describe, which would tag a whole group at once', () => {
    const groups = specSources()
      .filter(({ source }) => DESCRIBE_WITH_CORE.test(source))
      .map(({ name }) => name)
    expect(groups).toEqual([])
  })
})
