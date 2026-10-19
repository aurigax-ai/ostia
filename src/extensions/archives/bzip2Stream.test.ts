import { join } from 'node:path'
import { BROWSE_LIMITS } from '@aurigax-ai/ostia-extension-sdk/contract/fileBrowse'
import { describe, expect, it } from 'vitest'
import { bz2 } from '../../../test/fixtures/archives/bzip2Fixture'
import { archiveDecoders } from '../../../test/fixtures/archives/decoders'
import { Bzip2Stream } from './bzip2Stream'
import { listAll, memoryFile } from './memoryFile'
import { tarProvider } from './tar'

const WORKER = join(__dirname, '../../../out/extensions/archives/bzip2.thread.js')
const tar = tarProvider(archiveDecoders)

describe('the bzip2 worker', () => {
  it('is stopped once the stream is destroyed in the middle of a block', async () => {
    const stream = new Bzip2Stream(WORKER)
    stream.write(bz2('a64m.bz2'))
    stream.end()
    await new Promise((resolve) => stream.once('data', resolve))
    stream.destroy()
    await stream.exited
    expect(stream.destroyed).toBe(true)
  })

  it('is stopped at the scan time limit, and the next listing still works', async () => {
    const started = Date.now()
    const slow = await listAll(tar, memoryFile(bz2('bigentry.tar.bz2')), {
      ...BROWSE_LIMITS,
      scanMs: 30,
    })
    expect(slow.result.ok && slow.result.complete).toBeFalsy()
    expect(Date.now() - started).toBeLessThan(2_000)
    const small = await listAll(tar, memoryFile(bz2('docs-link.tar.bz2')))
    expect(small.result).toEqual({ ok: true, complete: true })
    expect(small.entries.map((entry) => entry.name)).toEqual(['docs/readme.txt', 'passwd'])
  })

  it('stops when cancelled while it decodes', async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 20)
    const { result } = await listAll(
      tar,
      memoryFile(bz2('bigentry.tar.bz2')),
      undefined,
      abort.signal,
    )
    expect(result).toEqual({ ok: false, error: 'cancelled' })
  })

  it('reports a worker that died as a failed listing', async () => {
    const dead = tarProvider({
      ...archiveDecoders,
      bzip2: () => new Bzip2Stream(join(__dirname, 'missing.thread.js')),
    })
    const { result } = await listAll(dead, memoryFile(bz2('docs-link.tar.bz2')))
    expect(result.ok).toBe(false)
  })
})
