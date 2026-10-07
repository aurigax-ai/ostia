import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const E2E = join(process.cwd(), 'e2e')
const PLAYWRIGHT_IMPORT = /from '@playwright\/test'/

describe('e2e imports', () => {
  it('takes Playwright only through e2e/test.ts, which keeps the app trace of a failing test', () => {
    const direct = readdirSync(E2E)
      .filter((name) => name.endsWith('.ts') && name !== 'test.ts')
      .filter((name) => PLAYWRIGHT_IMPORT.test(readFileSync(join(E2E, name), 'utf8')))
    expect(direct).toEqual([])
  })
})
