import { describe, expect, it } from 'vitest'
import { zerosDeflated, zipOf } from '../../../test/fixtures/archives/archives'
import { listAll, memoryFile, readEntry } from './memoryFile'
import { zip } from './zip'

const MIB = 1024 * 1024

describe('zip provider', () => {
  it('lists every entry in order with its size, kind, link and encryption', async () => {
    const file = memoryFile(
      zipOf([
        { name: 'docs/', data: '' },
        { name: 'docs/readme.txt', data: 'hello' },
        { name: 'shadow', data: '/etc/shadow', mode: 0o120777 },
        { name: 'secret.txt', data: 'x', flags: 0x0801 },
      ]),
    )
    const { entries, result } = await listAll(zip, file)
    expect(result).toEqual({ ok: true, complete: true })
    expect(entries).toEqual([
      { name: 'docs/', dir: true, size: 0, encrypted: false, link: null },
      { name: 'docs/readme.txt', dir: false, size: 5, encrypted: false, link: null },
      { name: 'shadow', dir: false, size: 11, encrypted: false, link: '/etc/shadow' },
      { name: 'secret.txt', dir: false, size: 1, encrypted: true, link: null },
    ])
  })

  it('reads one entry by its number, in chunks', async () => {
    const file = memoryFile(
      zipOf([
        { name: 'a.txt', data: 'first' },
        { name: 'b.txt', data: 'second' },
      ]),
    )
    const read = await readEntry(zip, file, 1)
    expect(read.result).toEqual({ ok: true })
    expect(read.data.toString()).toBe('second')
  })

  it('refuses links and encrypted entries, and says gone for a number past the end', async () => {
    const file = memoryFile(
      zipOf([
        { name: 'shadow', data: '/etc/shadow', mode: 0o120777 },
        { name: 'secret.txt', data: 'x', flags: 0x0801 },
      ]),
    )
    expect((await readEntry(zip, file, 0)).result).toEqual({ ok: false, error: 'link' })
    expect((await readEntry(zip, file, 1)).result).toEqual({ ok: false, error: 'encrypted' })
    expect((await readEntry(zip, file, 2)).result).toEqual({ ok: false, error: 'gone' })
  })

  it('stops an entry that is larger than it declared and one that is over the cap', async () => {
    const file = memoryFile(
      zipOf([
        { name: 'liar.bin', deflated: zerosDeflated(4 * MIB), size: 1024 },
        { name: 'big.bin', deflated: zerosDeflated(MIB), size: 1024 * MIB },
        { name: 'wide.bin', deflated: zerosDeflated(2 * MIB), size: 2 * MIB },
      ]),
    )
    expect((await readEntry(zip, file, 0)).result).toEqual({ ok: false, error: 'limit' })
    expect((await readEntry(zip, file, 1)).result).toMatchObject({ ok: false, error: 'too-large' })
    expect((await readEntry(zip, file, 2, MIB + 10)).result).toMatchObject({
      ok: false,
      error: 'too-large',
    })
  })

  it('stops listing when the host says no more, and reports a damaged file as corrupt', async () => {
    const many = Array.from({ length: 30 }, (_unused, i) => ({ name: `f${i}`, data: 'x' }))
    const limited = await listAll(zip, memoryFile(zipOf(many)), {
      entries: 5,
      depth: 32,
      nameLength: 1024,
      scanBytes: 1024 * MIB,
      scanMs: 20_000,
      linkTargetBytes: 1024,
    })
    expect(limited.result).toEqual({ ok: true, complete: false })
    expect(limited.entries.length).toBe(6)
    const broken = await listAll(zip, memoryFile(new TextEncoder().encode('not a zip at all')))
    expect(broken.result).toEqual({ ok: false, error: 'corrupt' })
  })

  it('stops when the request is cancelled', async () => {
    const abort = new AbortController()
    abort.abort()
    const { result } = await listAll(
      zip,
      memoryFile(zipOf([{ name: 'a', data: 'x' }])),
      undefined,
      abort.signal,
    )
    expect(result).toEqual({ ok: false, error: 'cancelled' })
  })
})
