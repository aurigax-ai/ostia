import { argon2Sync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sourceFiles } from '../../../test/sourceFiles'
import { argon2idKey } from './argon2'

const MAIN_DIR = join(__dirname, '..')

describe('argon2idKey', () => {
  it('SSY-C17 derives what the OpenSSL argon2id derives, for one lane and for four', async () => {
    const salt = Buffer.from('0123456789abcdef')
    for (const cost of [
      { memoryKiB: 1024, passes: 2, lanes: 1 },
      { memoryKiB: 4096, passes: 3, lanes: 4 },
    ]) {
      const expected = argon2Sync('argon2id', {
        message: Buffer.from('correct horse', 'utf8'),
        nonce: salt,
        parallelism: cost.lanes,
        tagLength: 32,
        memory: cost.memoryKiB,
        passes: cost.passes,
      })
      expect((await argon2idKey('correct horse', salt, cost)).equals(expected)).toBe(true)
    }
  })

  it('SSY-C18 is the only argon2 in main, because Electron ships no node:crypto argon2', () => {
    const offenders = sourceFiles(MAIN_DIR, '**/!(*.d|*.test).ts').filter((file) =>
      /\bargon2(Sync)?\b[^'\n]*from 'node:crypto'|from 'node:crypto'[^\n]*\bargon2\b/.test(
        readFileSync(file, 'utf8'),
      ),
    )
    expect(offenders).toEqual([])
  })
})
