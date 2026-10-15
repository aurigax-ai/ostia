import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './affectedTests.mjs'

const MAX_LINES_OUTSIDE_BOOT = 841

describe('src/main/app.ts', () => {
  it('gains no lines outside boot(); feature wiring lives in <feature>/<feature>Wiring.ts', () => {
    const lines = readFileSync(join(ROOT, 'src/main/app.ts'), 'utf8').trimEnd().split('\n')
    const start = lines.indexOf('function boot(): void {')
    const end = lines.indexOf('}', start)
    expect(start).toBeGreaterThan(-1)
    expect(lines.length - (end - start + 1)).toBeLessThanOrEqual(MAX_LINES_OUTSIDE_BOOT)
  })
})
