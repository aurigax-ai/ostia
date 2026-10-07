import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const launcher = join(__dirname, '../../packaging/bin/ostia')
const fakeApp = '#!/bin/sh\necho "$ELECTRON_RUN_AS_NODE|$OSTIA_APP_BIN|$*"\n'

function install(layout: 'mac' | 'linux'): { root: string; script: string; appBin: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-launcher-')))
  const contents = layout === 'mac' ? join(root, 'Ostia.app', 'Contents') : join(root, 'Ostia')
  const resources = layout === 'mac' ? join(contents, 'Resources') : join(contents, 'resources')
  const appBin = layout === 'mac' ? join(contents, 'MacOS', 'Ostia') : join(contents, 'ostia')
  mkdirSync(join(resources, 'bin'), { recursive: true })
  mkdirSync(join(appBin, '..'), { recursive: true })
  writeFileSync(appBin, fakeApp)
  chmodSync(appBin, 0o755)
  const script = join(resources, 'bin', 'ostia')
  copyFileSync(launcher, script)
  chmodSync(script, 0o755)
  return { root, script, appBin }
}

function run(script: string, args: string[]): string {
  const result = spawnSync(script, args, { encoding: 'utf8' })
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

describe('ostia launcher', () => {
  it('runs the macOS app binary as node on the bundled cli', () => {
    const { script, appBin } = install('mac')
    const resources = join(script, '..', '..')
    expect(run(script, ['workspace', 'list', '--json'])).toBe(
      `1|${appBin}|${resources}/app.asar/out/cli/index.js workspace list --json`,
    )
  })

  it('follows a symlink on the PATH back into the app bundle', () => {
    const { root, script, appBin } = install('mac')
    mkdirSync(join(root, 'bin'))
    const link = join(root, 'bin', 'ostia')
    symlinkSync(script, link)
    expect(run(link, ['--help']).split('|')[1]).toBe(appBin)
  })

  it('follows a relative symlink', () => {
    const { root, script, appBin } = install('mac')
    mkdirSync(join(root, 'bin'))
    const link = join(root, 'bin', 'ostia')
    symlinkSync(join('..', 'Ostia.app', 'Contents', 'Resources', 'bin', 'ostia'), link)
    expect(script).toContain('Ostia.app')
    expect(run(link, ['--help']).split('|')[1]).toBe(appBin)
  })

  it('keeps using the executable next to resources on Linux', () => {
    const { script, appBin } = install('linux')
    expect(run(script, ['--help']).split('|')[1]).toBe(appBin)
  })
})
