import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts', 'electron-headers.sh')
const root = mkdtempSync(join(tmpdir(), 'ostia-headers-'))
const cache = join(root, 'cache')
const version = '44.5.1'

afterAll(() => rmSync(root, { recursive: true, force: true }))

function homeWithHeaders(name: string, header: string | null): string {
  const home = join(root, name)
  const dir = join(home, '.electron-gyp', version)
  mkdirSync(join(dir, 'include', 'node'), { recursive: true })
  if (header !== null) {
    writeFileSync(join(dir, 'include', 'node', 'node.h'), header)
    writeFileSync(join(dir, 'installVersion'), '11')
  }
  return home
}

function run(action: string, home: string) {
  const result = spawnSync('bash', [script, action, cache, version], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
  return { status: result.status, stderr: result.stderr }
}

const cachedHeader = () => readFileSync(join(cache, version, 'include', 'node', 'node.h'), 'utf8')

describe.skipIf(process.platform !== 'linux')('scripts/electron-headers.sh', () => {
  it('finds nothing to restore in an empty cache or an incomplete folder', () => {
    expect(run('restore', join(root, 'empty-home')).status).toBe(1)
    mkdirSync(join(root, 'partial-cache', version), { recursive: true })
    const partial = spawnSync('bash', [script, 'restore', join(root, 'partial-cache'), version], {
      env: { ...process.env, HOME: join(root, 'empty-home') },
    })
    expect(partial.status).toBe(1)
    expect(existsSync(join(root, 'empty-home', '.electron-gyp'))).toBe(false)
  })

  it('refuses to publish headers that are not complete', () => {
    const { status, stderr } = run('publish', homeWithHeaders('incomplete', null))
    expect(status).toBe(1)
    expect(stderr).toContain('no complete headers')
    expect(existsSync(join(cache, version))).toBe(false)
  })

  it('publishes one complete copy when many jobs publish at once', async () => {
    const homes = Array.from({ length: 10 }, (_, i) => homeWithHeaders(`job-${i}`, `job ${i}`))
    const statuses = await Promise.all(
      homes.map(
        (home) =>
          new Promise<number | null>((resolve) => {
            spawn('bash', [script, 'publish', cache, version], {
              env: { ...process.env, HOME: home },
            }).once('exit', resolve)
          }),
      ),
    )
    expect(statuses).toEqual(homes.map(() => 0))
    expect(readdirSync(cache)).toEqual([version])
    expect(cachedHeader()).toMatch(/^job \d$/)
    expect(readFileSync(join(cache, version, 'installVersion'), 'utf8')).toBe('11')
  })

  it('never writes into a version that is already published', () => {
    const before = cachedHeader()
    expect(run('publish', homeWithHeaders('late', 'late job')).status).toBe(0)
    expect(cachedHeader()).toBe(before)
    expect(readdirSync(cache)).toEqual([version])
  })

  it('restores a private copy the job can change without touching the cache', () => {
    const home = join(root, 'fresh')
    expect(run('restore', home).status).toBe(0)
    const own = join(home, '.electron-gyp', version, 'include', 'node', 'node.h')
    const before = cachedHeader()
    expect(readFileSync(own, 'utf8')).toBe(before)
    writeFileSync(own, 'changed by the job')
    expect(cachedHeader()).toBe(before)
  })
})
