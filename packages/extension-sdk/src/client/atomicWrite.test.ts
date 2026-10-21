import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFileAtomic, writeFileAtomicAsync } from './atomicWrite'

const fixed = vi.hoisted(() => ({ bytes: null as Buffer | null }))

vi.mock('node:crypto', async (importOriginal) => {
  const crypto = await importOriginal<typeof import('node:crypto')>()
  return { ...crypto, randomBytes: (size: number) => fixed.bytes ?? crypto.randomBytes(size) }
})

const DEAD_PID = 2 ** 22 + 1
const HEX = '0123456789abcdef'
const HOST = createHash('sha256').update(hostname()).digest('hex').slice(0, 8)
const OTHER_HOST = HOST === 'ffffffff' ? 'eeeeeeee' : 'ffffffff'

const writers = [
  ['writeFileAtomic', async (path: string, text: string) => writeFileAtomic(path, text)],
  ['writeFileAtomicAsync', writeFileAtomicAsync],
] as const

describe.each(writers)('%s', (_name, write) => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-atomic-write-'))
    fixed.bytes = null
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('leaves a temp file it did not create alone when its name is taken', async () => {
    fixed.bytes = Buffer.from(HEX, 'hex')
    const theirs = join(dir, `store.json.${HOST}.${process.pid}.${HEX}.tmp`)
    writeFileSync(theirs, 'theirs')
    await expect(write(join(dir, 'store.json'), '{}')).rejects.toMatchObject({ code: 'EEXIST' })
    expect(readFileSync(theirs, 'utf8')).toBe('theirs')
  })

  it('removes temp files of this store left by a process of this host that is gone', async () => {
    const stale = `store.json.${HOST}.${DEAD_PID}.${HEX}.tmp`
    const kept = [
      `store.json.${HOST}.${process.ppid}.${HEX}.tmp`,
      `store.json.${OTHER_HOST}.${DEAD_PID}.${HEX}.tmp`,
      `other.json.${HOST}.${DEAD_PID}.${HEX}.tmp`,
    ]
    for (const name of [stale, ...kept]) writeFileSync(join(dir, name), 'secret')
    await write(join(dir, 'store.json'), '{}')
    expect(readdirSync(dir).sort()).toEqual([...kept, 'store.json'].sort())
  })
})
