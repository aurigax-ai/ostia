import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT } from './affectedTests.mjs'

const MAX_APP_LINES = 25

function source(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8')
}

function mainSources(): string[] {
  return execFileSync('git', ['ls-files', 'src/main'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter((file) => /\.ts$/.test(file) && !/\.test\.ts$/.test(file))
}

describe('src/main/app.ts', () => {
  it('only chains the main/boot builders; new wiring goes in main/boot or <feature>/<feature>Wiring.ts', () => {
    expect(source('src/main/app.ts').trimEnd().split('\n').length).toBeLessThanOrEqual(
      MAX_APP_LINES,
    )
  })
})

describe('services.requestQuit', () => {
  it('is set once, by the quit builder, before app.ts waits for ready', () => {
    const writers = mainSources().filter((file) =>
      /services\.requestQuit\s*=(?!=)/.test(source(file)),
    )
    expect(writers).toEqual(['src/main/boot/quitServices.ts'])
    const app = source('src/main/app.ts')
    const built = app.indexOf('createQuitServices(')
    expect(built).toBeGreaterThan(-1)
    expect(built).toBeLessThan(app.indexOf('app.whenReady()'))
  })
})
