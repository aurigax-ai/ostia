import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  LOG_FIELD_MAX_CHARS,
  createAppLog,
  formatEntry,
  redactSecrets,
  rotateLogFiles,
  rotatedName,
} from './appLog'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-applog-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('redactSecrets', () => {
  it('hides key=value secrets, bearer tokens and long opaque strings', () => {
    const text = [
      'OSTIA_TOKEN=abc123def456',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig',
      'url https://x.test/cb?access_token=s3cr3t&page=2',
      'key sk-proj-ABCDEFGHIJKLMNOP',
      'gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      `blob ${'a1B2'.repeat(12)}`,
      '"password": "hunter2"',
    ].join('\n')
    const out = redactSecrets(text)
    for (const secret of [
      'abc123def456',
      'eyJhbGciOiJIUzI1NiJ9',
      's3cr3t',
      'sk-proj-ABCDEFGHIJKLMNOP',
      'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
      'a1B2a1B2a1B2a1B2a1B2',
      'hunter2',
    ]) {
      expect(out).not.toContain(secret)
    }
    expect(out).toContain('page=2')
  })

  it('keeps ordinary error text and stack frames', () => {
    const text = 'TypeError: x is undefined\n    at DiffView (index-BCk7BOBV.js:12:3)'
    expect(redactSecrets(text)).toBe(text)
  })
})

describe('formatEntry', () => {
  it('writes the event and quotes values with spaces or newlines on one line', () => {
    const line = formatEntry('renderer-error', {
      window: 3,
      message: 'boom here',
      stack: 'a\nb',
      skipped: undefined,
    })
    expect(line).toBe('renderer-error window=3 message="boom here" stack="a\\nb"')
    expect(line).not.toContain('\n')
  })

  it('clips long values and redacts them', () => {
    const line = formatEntry('x', { message: `token=zzz ${'y '.repeat(LOG_FIELD_MAX_CHARS)}` })
    expect(line).not.toContain('zzz')
    expect(line.length).toBeLessThan(LOG_FIELD_MAX_CHARS + 100)
    expect(line).toContain('more)')
  })
})

describe('rotateLogFiles', () => {
  it('shifts archives and keeps only the configured number of files', () => {
    const dir = tempDir()
    const file = join(dir, 'main.log')
    for (const n of [1, 2, 3, 4]) {
      writeFileSync(file, `gen${n}`)
      rotateLogFiles(file, 3)
    }
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log'])
    expect(readFileSync(rotatedName(file, 1), 'utf8')).toBe('gen4')
    expect(readFileSync(rotatedName(file, 2), 'utf8')).toBe('gen3')
  })
})

describe('createAppLog', () => {
  it('appends redacted entries to the file', () => {
    const file = join(tempDir(), 'logs', 'main.log')
    const log = createAppLog(file)
    log.info('app-start', { version: '0.0.9' })
    log.error('renderer-error', { message: 'failed with OSTIA_TOKEN=abcdef123456' })
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/\[info\]\s+app-start version=0\.0\.9/)
    expect(text).toMatch(
      /\[error\]\s+renderer-error message="failed with OSTIA_TOKEN=\[redacted\]"/,
    )
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('rotates at the size cap and keeps three files at most', () => {
    const dir = tempDir()
    const file = join(dir, 'main.log')
    const log = createAppLog(file, { maxBytes: 2048, keep: 3 })
    for (let i = 0; i < 200; i++) log.info('pty-reap', { pane: `p-${i}`, reason: 'grace-expired' })
    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    expect(statSync(file).size).toBeLessThan(2048 + 200)
    expect(readFileSync(file, 'utf8')).toContain('pane=p-199')
    expect(existsSync(rotatedName(file, 3))).toBe(false)
  })
})
