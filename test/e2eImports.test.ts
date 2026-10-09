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

  it('tags at most 34 e2e tests @core, so the merge queue runs a small set', () => {
    const tagged = readdirSync(E2E)
      .filter((name) => name.endsWith('.spec.ts'))
      .flatMap((name) => {
        const source = readFileSync(join(E2E, name), 'utf8')
        return source.match(/tag:\s*(?:'@core'|\[[^\]]*'@core'[^\]]*\])/g) ?? []
      })
    expect(tagged.length).toBeLessThanOrEqual(34)
  })
})
