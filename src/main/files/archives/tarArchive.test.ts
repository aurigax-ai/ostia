import { randomBytes } from 'node:crypto'
import type { ReadStream } from 'node:fs'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const opened: ReadStream[] = vi.hoisted(() => [])

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    createReadStream: ((...args: Parameters<typeof fs.createReadStream>) => {
      const stream = fs.createReadStream(...args)
      opened.push(stream)
      return stream
    }) as typeof fs.createReadStream,
  }
})

import { tarOf } from '../../../../test/fixtures/archives/archives'
import { ARCHIVE_LIMITS } from './archiveTree'
import { listTar, readTarEntry } from './tarArchive'

const MIB = 1024 * 1024
const TRAILING = 2 * MIB
let dir: string

function withTrailing(gzip: boolean): string {
  const tar = tarOf(
    [
      { name: 'a.txt', data: 'first' },
      { name: 'b.txt', data: 'last' },
    ],
    false,
  )
  const bytes = Buffer.concat([tar, randomBytes(TRAILING)])
  const path = join(dir, gzip ? 'trailing.tar.gz' : 'trailing.tar')
  writeFileSync(path, gzip ? gzipSync(bytes) : bytes)
  return path
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tar-eof-'))
  opened.length = 0
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe.each([
  ['tar', false],
  ['tar.gz', true],
])('%s with data after the end marker', (_name, gzip) => {
  it('lists every entry and stops reading the file at the marker', async () => {
    const listed = await listTar(withTrailing(gzip), ARCHIVE_LIMITS)
    expect(listed?.map((entry) => entry.name)).toEqual(['a.txt', 'b.txt'])
    expect(opened).toHaveLength(1)
    expect(opened[0].destroyed).toBe(true)
    expect(opened[0].bytesRead).toBeLessThan(MIB)
  })

  it('reads the last entry and stops reading the file at the marker', async () => {
    const read = await readTarEntry(withTrailing(gzip), 1, MIB, ARCHIVE_LIMITS)
    expect(read.ok && read.data.toString()).toBe('last')
    expect(opened).toHaveLength(1)
    expect(opened[0].destroyed).toBe(true)
    expect(opened[0].bytesRead).toBeLessThan(MIB)
  })

  it('reports a missing entry and stops reading the file at the marker', async () => {
    const read = await readTarEntry(withTrailing(gzip), 2, MIB, ARCHIVE_LIMITS)
    expect(read).toEqual({ ok: false, problem: 'gone' })
    expect(opened).toHaveLength(1)
    expect(opened[0].destroyed).toBe(true)
    expect(opened[0].bytesRead).toBeLessThan(MIB)
  })
})
