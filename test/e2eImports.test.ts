import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { chords, defaultChord } from '../e2e/chords'
import { dataHomeBase } from '../e2e/dataHome'
import { KEPT_SHELLS_DIR } from '../src/shared/terminal/keepShells'

const E2E = join(process.cwd(), 'e2e')
const PLAYWRIGHT_IMPORT = /from '@playwright\/test'/
const CORE_MARK = /@core\b/g
const FIXED_SLEEP = /waitForTimeout\(|setTimeout\(resolve/g
const FIXED_SLEEP_CAP = 8
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

  it(`keeps at most ${FIXED_SLEEP_CAP} fixed sleeps in e2e specs, a cap that only goes down; wait on a state instead`, () => {
    const sleeps = specSources().flatMap(({ source }) => source.match(FIXED_SLEEP) ?? [])
    expect(sleeps.length).toBeLessThanOrEqual(FIXED_SLEEP_CAP)
  })

  it('never puts @core on a describe, which would tag a whole group at once', () => {
    const groups = specSources()
      .filter(({ source }) => DESCRIBE_WITH_CORE.test(source))
      .map(({ name }) => name)
    expect(groups).toEqual([])
  })
})

describe('e2e specs', () => {
  it('keep no retries and no .fixme( in any *.spec.ts under e2e/ (the files testMatch runs; failed-report/ has none), so a flaky or skipped test goes through test/quarantine.json', () => {
    const offenders = readdirSync(E2E, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.spec.ts'))
      .filter((name) => /\bretries\b|\.fixme\(/.test(readFileSync(join(E2E, name), 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('e2e chords', () => {
  it('press the palette chord the app binds by default on each platform', () => {
    expect(defaultChord('palette.toggle', true)).toBe('Shift+Meta+p')
    expect(defaultChord('palette.toggle', false)).toBe('Control+Shift+p')
    expect(chords.palette).toBe(defaultChord('palette.toggle', process.platform === 'darwin'))
  })

  it('open the palette through chords.palette in every spec that runs on macOS', () => {
    const offenders = specSources()
      .filter(({ name }) => name !== 'keybindings.spec.ts')
      .filter(({ source }) => /press\('Control\+Shift\+P'\)/i.test(source))
      .map(({ name }) => name)
    expect(offenders).toEqual([])
  })
})

describe('e2e data home', () => {
  const MACOS_SOCKET_PATH_MAX = 103
  const RUNNER_TMPDIR = '/var/folders/9f/2kx1l3_x6k7gxv7m0m6dmc4w0000gn/T'
  const keptSocket = (base: string): string =>
    join('/private', base, 'ostia-e2e-data-AbC123', 'userData', KEPT_SHELLS_DIR, 'f'.repeat(16))

  it('keeps the kept-shells tmux socket under the macOS limit, which the runner TMPDIR passes', () => {
    expect(keptSocket(RUNNER_TMPDIR).length).toBeGreaterThan(MACOS_SOCKET_PATH_MAX)
    expect(keptSocket(dataHomeBase('darwin', RUNNER_TMPDIR)).length).toBeLessThanOrEqual(
      MACOS_SOCKET_PATH_MAX,
    )
    expect(dataHomeBase('linux', '/tmp/run-1')).toBe('/tmp/run-1')
  })
})
