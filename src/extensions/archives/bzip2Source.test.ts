import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ArchiveReaderLimits } from '@aurigax-ai/ostia-extension-sdk/contract/archiveReaders'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tarOf } from '../../../test/fixtures/archives/archives'
import { listArchive } from './archiveAnswers'
import { Bzip2Stream, bzip2Opener } from './bzip2Source'

const MIB = 1024 * 1024
const WORKER = join(__dirname, '../../../out/extensions/archives/bzip2.thread.js')
const LIMITS: ArchiveReaderLimits = {
  entries: 20_000,
  depth: 32,
  nameLength: 1_024,
  scanBytes: 1024 * MIB,
  scanMs: 20_000,
  linkTargetBytes: 1_024,
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bzip2-worker-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function put(name: string, bytes: Uint8Array): string {
  const path = join(dir, name)
  writeFileSync(path, execFileSync('bzip2', ['-9', '-c'], { input: bytes, maxBuffer: 64 * MIB }))
  return path
}

function noise(): Uint8Array {
  const items = Array.from({ length: 6 }, (_unused, i) => ({
    name: `noise${i}.bin`,
    data: randomBytes(400_000).toString('latin1'),
  }))
  return tarOf(items, false)
}

describe('the bzip2 worker', () => {
  it('is stopped once the stream is destroyed in the middle of a block', async () => {
    const stream = new Bzip2Stream(WORKER)
    stream.write(
      execFileSync('bzip2', ['-9', '-c'], { input: randomBytes(2 * MIB), maxBuffer: 4 * MIB }),
    )
    stream.end()
    await new Promise((resolve) => stream.once('data', resolve))
    stream.destroy()
    await stream.exited
    expect(stream.destroyed).toBe(true)
  })

  it('is stopped at the scan time limit, and the next listing still works', async () => {
    const opener = bzip2Opener(WORKER)
    const started = Date.now()
    const live = new AbortController().signal
    const slow = await listArchive(
      {
        op: 'list',
        reader: 'bzip2',
        archive: put('noise.tar.bz2', noise()),
        limits: { ...LIMITS, scanMs: 30 },
      },
      opener,
      live,
    )
    expect(slow.ok ? slow.complete : false).toBe(false)
    expect(Date.now() - started).toBeLessThan(2_000)
    const path = put('small.tar.bz2', tarOf([{ name: 'a.txt', data: 'x' }], false))
    expect(
      await listArchive(
        { op: 'list', reader: 'bzip2', archive: path, limits: LIMITS },
        opener,
        live,
      ),
    ).toMatchObject({
      ok: true,
      complete: true,
    })
  })

  it('stops when cancelled while it decodes', async () => {
    const abort = new AbortController()
    const pending = listArchive(
      { op: 'list', reader: 'bzip2', archive: put('noise.tar.bz2', noise()), limits: LIMITS },
      bzip2Opener(WORKER),
      abort.signal,
    )
    setTimeout(() => abort.abort(), 20)
    const result = await pending
    expect(result.ok ? result.complete : false).toBe(false)
  })

  it('reports a worker that died as a failed listing', async () => {
    const result = await listArchive(
      {
        op: 'list',
        reader: 'bzip2',
        archive: put('a.tar.bz2', tarOf([{ name: 'a', data: 'x' }], false)),
        limits: LIMITS,
      },
      bzip2Opener(join(dir, 'missing.thread.js')),
      new AbortController().signal,
    )
    expect(result).toEqual({ ok: false, error: 'failed' })
  })
})
