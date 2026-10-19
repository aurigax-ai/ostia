import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { BROWSE_LIMITS } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { describe, expect, it } from 'vitest'
import { tarOf } from '../../../test/fixtures/archives/archives'
import { archiveDecoders } from '../../../test/fixtures/archives/decoders'
import { Bzip2Stream } from './bzip2Stream'
import { listAll, memoryFile } from './memoryFile'
import { tarProvider } from './tar'

const MIB = 1024 * 1024
const WORKER = join(__dirname, '../../../out/extensions/archives/bzip2.thread.js')
const tar = tarProvider(archiveDecoders)

function bzip2(bytes: Uint8Array): Buffer {
  return execFileSync('bzip2', ['-9', '-c'], { input: bytes, maxBuffer: 64 * MIB })
}

function noise(): Buffer {
  const items = Array.from({ length: 6 }, (_unused, i) => ({
    name: `noise${i}.bin`,
    data: randomBytes(400_000).toString('latin1'),
  }))
  return bzip2(tarOf(items, false))
}

describe('the bzip2 worker', () => {
  it('is stopped once the stream is destroyed in the middle of a block', async () => {
    const stream = new Bzip2Stream(WORKER)
    stream.write(bzip2(randomBytes(2 * MIB)))
    stream.end()
    await new Promise((resolve) => stream.once('data', resolve))
    stream.destroy()
    await stream.exited
    expect(stream.destroyed).toBe(true)
  })

  it('is stopped at the scan time limit, and the next listing still works', async () => {
    const started = Date.now()
    const slow = await listAll(tar, memoryFile(noise()), { ...BROWSE_LIMITS, scanMs: 30 })
    expect(slow.result.ok && slow.result.complete).toBeFalsy()
    expect(Date.now() - started).toBeLessThan(2_000)
    const small = await listAll(
      tar,
      memoryFile(bzip2(tarOf([{ name: 'a.txt', data: 'x' }], false))),
    )
    expect(small.result).toEqual({ ok: true, complete: true })
    expect(small.entries.map((entry) => entry.name)).toEqual(['a.txt'])
  })

  it('stops when cancelled while it decodes', async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 20)
    const { result } = await listAll(tar, memoryFile(noise()), undefined, abort.signal)
    expect(result).toEqual({ ok: false, error: 'cancelled' })
  })

  it('reports a worker that died as a failed listing', async () => {
    const dead = tarProvider({
      ...archiveDecoders,
      bzip2: () => new Bzip2Stream(join(__dirname, 'missing.thread.js')),
    })
    const { result } = await listAll(
      dead,
      memoryFile(bzip2(tarOf([{ name: 'a', data: 'x' }], false))),
    )
    expect(result.ok).toBe(false)
  })
})
