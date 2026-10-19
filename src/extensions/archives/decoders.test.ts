import { gzipSync, zstdCompressSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import { tarOf } from '../../../test/fixtures/archives/archives'
import { DOCS_ITEMS } from '../../../test/fixtures/archives/bzip2Data'
import { decodersIn } from './decoders'
import { listAll, memoryFile } from './memoryFile'
import { tarProvider } from './tar'

const PLAIN = tarOf(DOCS_ITEMS, false)

function withoutTheBinary() {
  const load = vi.fn(() => {
    throw new Error('Cannot find module @napi-rs/lzma-linux-x64-gnu')
  })
  return { load, tar: tarProvider(decodersIn('/nowhere', load)) }
}

describe('decoders without the native xz module', () => {
  it('does not touch the module until an xz stream is decoded', async () => {
    const { load, tar } = withoutTheBinary()
    expect(load).not.toHaveBeenCalled()
    for (const bytes of [PLAIN, gzipSync(PLAIN), zstdCompressSync(PLAIN)]) {
      const { entries, result } = await listAll(tar, memoryFile(bytes))
      expect(result).toEqual({ ok: true, complete: true })
      expect(entries.map((entry) => entry.name)).toEqual(['docs/readme.txt', 'passwd'])
    }
    expect(load).not.toHaveBeenCalled()
  })

  it('fails an xz archive with a failed listing instead of taking the extension down', async () => {
    const { load, tar } = withoutTheBinary()
    const xz = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0, 4, 0xe6, 0xd6, 0xb4, 0x46])
    const { result } = await listAll(tar, memoryFile(xz))
    expect(result).toEqual({ ok: false, error: 'failed' })
    expect(load).toHaveBeenCalledTimes(1)
  })
})
