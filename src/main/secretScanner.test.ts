import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { FAKE } from '../../test/fixtures/secrets/samples'
import { SCAN_CHUNK_MAX, kindOfRule, libraryKinds, scanSecrets } from './secretScanner'

const run = promisify(execFile)
const electronBinary = createRequire(__filename)('electron') as unknown as string
const probe = resolve(__dirname, '../../test/fixtures/secrets/electronProbe.mjs')

describe('kindOfRule', () => {
  it('names a kind after its rule package', () => {
    expect(kindOfRule('@secretlint/secretlint-rule-github')).toBe('github')
    expect(kindOfRule('@secretlint/secretlint-rule-database-connection-string')).toBe(
      'database-connection-string',
    )
    expect(kindOfRule('Some Other_Rule!')).toBe('some-other-rule')
  })
})

describe('libraryKinds', () => {
  it('has a unique, placeholder-safe kind for every rule', () => {
    const kinds = libraryKinds().map((k) => k.kind)
    expect(kinds.length).toBeGreaterThan(20)
    expect(new Set(kinds).size).toBe(kinds.length)
    for (const kind of kinds) expect(kind).toMatch(/^[a-z0-9][a-z0-9-]{0,47}$/)
  })
})

describe('scanSecrets', () => {
  it('reports the exact place of each secret', async () => {
    const text = `a ${FAKE.githubClassic} b ${FAKE.npm}`
    const spans = await scanSecrets(text)
    expect(spans.map((s) => [s.kind, text.slice(s.start, s.end)])).toEqual([
      ['github', FAKE.githubClassic],
      ['npm', FAKE.npm],
    ])
  })

  it('covers the whole AWS secret key, not the range the rule reports', async () => {
    const text = `AWS_SECRET_ACCESS_KEY="${FAKE.awsSecretKey}"`
    const spans = await scanSecrets(text)
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([FAKE.awsSecretKey])
  })

  it('reads text longer than one chunk with the right offsets', async () => {
    const filler = `${'filler line\n'.repeat(Math.ceil(SCAN_CHUNK_MAX / 12))}`
    const text = `${filler}${FAKE.gitlab}\n${filler}${FAKE.gitlab}\n`
    const spans = await scanSecrets(text)
    expect(spans).toHaveLength(2)
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(FAKE.gitlab)
  })

  it('finds nothing in empty text', async () => {
    expect(await scanSecrets('')).toEqual([])
  })
})

describe('the library under the runtime the app ships', () => {
  it("detects a secret under Electron's own Node", async () => {
    const { stdout } = await run(electronBinary, [probe, FAKE.githubClassic], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    expect(JSON.parse(stdout)).toEqual(['@secretlint/secretlint-rule-github'])
  })
})
