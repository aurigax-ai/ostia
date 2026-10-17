import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CURRENT_OWNER, keptOwnerFile, readKeptOwner, sameOwner, writeKeptOwner } from './keptOwner'

describe('kept-shells owner record', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kept-owner-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('names this process and the time it started', () => {
    expect(CURRENT_OWNER.pid).toBe(process.pid)
    expect(CURRENT_OWNER.startedAt).toBeLessThanOrEqual(Date.now())
    expect(Date.now() - CURRENT_OWNER.startedAt).toBeLessThan(
      Math.ceil(process.uptime() * 1000) + 1000,
    )
  })

  it('writes the owner to a 0600 file next to the socket and reads it back', () => {
    const file = keptOwnerFile(dir, 'k')
    expect(file).toBe(join(dir, 'k.owner.json'))
    writeKeptOwner(file, { pid: 42, startedAt: 1000 })
    expect(readKeptOwner(file)).toEqual({ pid: 42, startedAt: 1000 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readdirSync(dir)).toEqual(['k.owner.json'])
  })

  it('reads a missing, broken or partial record as unknown', () => {
    const file = keptOwnerFile(dir, 'k')
    expect(readKeptOwner(file)).toBeNull()
    writeFileSync(file, '{"pid":')
    expect(readKeptOwner(file)).toBeNull()
    writeFileSync(file, '{"pid":0,"startedAt":5}')
    expect(readKeptOwner(file)).toBeNull()
    writeFileSync(file, '{"pid":"12","startedAt":5}')
    expect(readKeptOwner(file)).toBeNull()
    writeFileSync(file, 'null')
    expect(readKeptOwner(file)).toBeNull()
    expect(existsSync(`${file}.partial`)).toBe(false)
  })

  it('counts the owner as the same only when pid and start time both match', () => {
    const owner = { pid: 7, startedAt: 100 }
    expect(sameOwner({ pid: 7, startedAt: 100 }, owner)).toBe(true)
    expect(sameOwner({ pid: 8, startedAt: 100 }, owner)).toBe(false)
    expect(sameOwner({ pid: 7, startedAt: 101 }, owner)).toBe(false)
    expect(sameOwner(null, owner)).toBe(false)
  })
})
