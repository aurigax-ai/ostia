import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  NO_ARTIFACT_FOLDER,
  STDIN_MAX_BYTES,
  captureStdin,
  defaultStdinName,
  readCapped,
  stdinFileName,
} from './stdinCapture'

const NOW = new Date(2026, 9, 8, 9, 5, 7)

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ostia-stdin-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('stdinFileName', () => {
  it('names an unnamed capture by its time', () => {
    expect(defaultStdinName(NOW)).toBe('stdin-20261008-090507.txt')
    expect(stdinFileName(undefined, NOW)).toEqual({ ok: true, name: 'stdin-20261008-090507.txt' })
  })

  it('takes a plain file name, which also picks the viewer', () => {
    expect(stdinFileName('change.diff', NOW)).toEqual({ ok: true, name: 'change.diff' })
    expect(stdinFileName('plan v2.md', NOW)).toEqual({ ok: true, name: 'plan v2.md' })
  })

  it('refuses a path, a leading dot, an empty or an overlong name', () => {
    for (const name of [
      'a/b.md',
      '../b.md',
      '/tmp/b.md',
      'a\\b.md',
      '.env',
      '..',
      '',
      'x'.repeat(201),
    ]) {
      expect(stdinFileName(name, NOW).ok, JSON.stringify(name)).toBe(false)
    }
  })
})

describe('readCapped', () => {
  it('joins the chunks of a stream within the cap', async () => {
    const out = await readCapped(Readable.from([Buffer.from('ab'), 'cd', Buffer.from('e')]), 5)
    expect(out?.toString()).toBe('abcde')
  })

  it('gives nothing once the stream is over the cap', async () => {
    expect(await readCapped(Readable.from([Buffer.alloc(3), Buffer.alloc(3)]), 5)).toBeNull()
  })

  it('caps at 16 MiB', () => {
    expect(STDIN_MAX_BYTES).toBe(16 * 1024 * 1024)
  })
})

describe('captureStdin', () => {
  const capture = (over: Partial<Parameters<typeof captureStdin>[0]> = {}) =>
    captureStdin({ dir, name: undefined, stream: Readable.from(['hello\n']), now: NOW, ...over })

  it('writes stdin as a private regular file in the artifact folder', async () => {
    const res = await capture({ name: 'report.md' })
    expect(res).toEqual({ ok: true, path: join(dir, 'report.md') })
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('hello\n')
    expect(statSync(join(dir, 'report.md')).mode & 0o777).toBe(0o600)
  })

  it('never overwrites: a second capture of the same name gets a number', async () => {
    writeFileSync(join(dir, 'report.md'), 'first')
    writeFileSync(join(dir, 'PAD.md'), 'the pad')
    expect(await capture({ name: 'report.md' })).toEqual({
      ok: true,
      path: join(dir, 'report-2.md'),
    })
    expect(await capture({ name: 'PAD.md' })).toEqual({ ok: true, path: join(dir, 'PAD-2.md') })
    expect(readFileSync(join(dir, 'report.md'), 'utf8')).toBe('first')
    expect(readFileSync(join(dir, 'PAD.md'), 'utf8')).toBe('the pad')
  })

  it('needs an artifact folder and never falls back to another place', async () => {
    expect(await capture({ dir: undefined })).toEqual({ ok: false, message: NO_ARTIFACT_FOLDER })
    expect(await capture({ dir: join(dir, 'missing') })).toEqual({
      ok: false,
      message: NO_ARTIFACT_FOLDER,
    })
    const file = join(dir, 'a-file')
    writeFileSync(file, '')
    expect(await capture({ dir: file })).toEqual({ ok: false, message: NO_ARTIFACT_FOLDER })
  })

  it('writes nothing when stdin is over the cap', async () => {
    const res = await capture({ stream: Readable.from([Buffer.alloc(11)]), max: 10 })
    expect(res.ok).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('writes nothing for a bad name, without reading stdin', async () => {
    let read = false
    const stream = Readable.from(
      (function* () {
        read = true
        yield 'x'
      })(),
    )
    const res = await capture({ name: '../escape.md', stream })
    expect(res).toEqual({ ok: false, message: 'ostia: --name is a file name, not a path' })
    expect(read).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
