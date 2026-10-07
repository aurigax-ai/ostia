import { execFileSync, spawnSync } from 'node:child_process'
import { constants, accessSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '../../..')
const helperName = process.platform === 'win32' ? 'ostia-tsnet.exe' : 'ostia-tsnet'

describe('ostia-tsnet build', () => {
  it('TSN-C1 builds a runnable helper that prints the package version', () => {
    const helper = join(root, 'out', 'tsnet', helperName)
    accessSync(helper, constants.X_OK)
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      version: string
    }
    expect(execFileSync(helper, ['--version'], { encoding: 'utf8' }).trim()).toBe(version)
  })

  it('TSN-C3 fails naming Go and the pinned toolchain when Go is missing', () => {
    const goLine = readFileSync(join(root, 'tsnet-helper', 'go.mod'), 'utf8').match(/^go (\S+)$/m)
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'build-tsnet.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GO: join(root, 'no-such-dir', 'go') },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Go')
    expect(result.stderr).toContain(goLine?.[1] ?? 'missing go line')
  })
})
