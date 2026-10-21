import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RANGE_CHUNK_MAX, type RangeReader, readRangeConfined } from './fsRange'

let dir: string
let outside: string
const MIB = 1024 * 1024
const confine = (path: string): string | null => (path.startsWith(`${dir}/`) ? path : null)

async function drain(reader: RangeReader): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = []
  for (let chunk = await reader.read(); chunk; chunk = await reader.read()) chunks.push(chunk)
  await reader.close()
  return chunks
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fs-range-'))
  outside = mkdtempSync(join(tmpdir(), 'fs-range-out-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('readRangeConfined', () => {
  it('reads exactly the requested bytes and reports the file size', async () => {
    const path = join(dir, 'a.bin')
    writeFileSync(path, '0123456789')
    const res = await readRangeConfined(path, 3, 6, confine)
    if (!res.ok) throw new Error('not ok')
    expect(res.reader.size).toBe(10)
    expect(Buffer.concat(await drain(res.reader)).toString()).toBe('3456')
  })

  it('splits a long range into chunks of at most 1 MiB', async () => {
    const path = join(dir, 'big.bin')
    writeFileSync(path, Buffer.alloc(0))
    truncateSync(path, 3 * MIB)
    const res = await readRangeConfined(path, 5, 5 + 2 * MIB + 99, confine)
    if (!res.ok) throw new Error('not ok')
    const sizes = (await drain(res.reader)).map((chunk) => chunk.byteLength)
    expect(sizes).toEqual([RANGE_CHUNK_MAX, RANGE_CHUNK_MAX, 100])
  })

  it('refuses paths outside the roots, symlinks, folders and bad bounds', async () => {
    writeFileSync(join(outside, 'secret'), 'secret')
    writeFileSync(join(dir, 'a.bin'), '0123456789')
    symlinkSync(join(outside, 'secret'), join(dir, 'link.bin'))
    mkdirSync(join(dir, 'folder'))
    expect(await readRangeConfined(join(outside, 'secret'), 0, 1, confine)).toEqual({
      ok: false,
      error: 'denied',
    })
    expect(await readRangeConfined(42, 0, 1, confine)).toEqual({ ok: false, error: 'denied' })
    expect(await readRangeConfined(join(dir, 'link.bin'), 0, 1, confine)).toEqual({
      ok: false,
      error: 'unreadable',
    })
    expect(await readRangeConfined(join(dir, 'folder'), 0, 1, confine)).toEqual({
      ok: false,
      error: 'unreadable',
    })
    expect(await readRangeConfined(join(dir, 'missing'), 0, 1, confine)).toEqual({
      ok: false,
      error: 'unreadable',
    })
    expect(await readRangeConfined(join(dir, 'a.bin'), 10, 12, confine)).toEqual({
      ok: false,
      error: 'unsatisfiable',
    })
    expect(await readRangeConfined(join(dir, 'a.bin'), 5, 2, confine)).toEqual({
      ok: false,
      error: 'unsatisfiable',
    })
    expect(await readRangeConfined(join(dir, 'a.bin'), -1, 2, confine)).toEqual({
      ok: false,
      error: 'unsatisfiable',
    })
  })

  it('throws instead of padding when the file shrank, and stops after close', async () => {
    const path = join(dir, 'shrink.bin')
    writeFileSync(path, Buffer.alloc(100))
    const res = await readRangeConfined(path, 0, 99, confine)
    if (!res.ok) throw new Error('not ok')
    truncateSync(path, 10)
    await expect(res.reader.read()).rejects.toThrow()
    expect(await res.reader.read()).toBeNull()
  })
})
