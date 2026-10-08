import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const linux = process.platform === 'linux'
const installScript = join(process.cwd(), 'packaging', 'linux', 'install.sh')
const userInstallScript = join(process.cwd(), 'packaging', 'linux', 'user-install.sh')
const localInstallScript = join(process.cwd(), 'scripts', 'install-linux.sh')
const headersScript = join(process.cwd(), 'scripts', 'electron-headers.sh')
const running: ChildProcess[] = []
let root: string
let home: string
let releases: string
let app: string
let desktopEntry: string
let icon: string
let scalableIcon: string
let cli: string
let settings: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-install-')))
  home = join(root, 'home')
  releases = join(root, 'release', 'aurigax-ai', 'ostia', 'releases')
  app = join(home, '.local', 'share', 'ostia', 'app')
  desktopEntry = join(home, '.local', 'share', 'applications', 'ostia.desktop')
  const icons = join(home, '.local', 'share', 'icons', 'hicolor')
  icon = join(icons, '16x16', 'apps', 'ostia.png')
  scalableIcon = join(icons, 'scalable', 'apps', 'ostia.svg')
  cli = join(home, '.local', 'bin', 'ostia')
  settings = join(home, '.config', 'ostia', 'settings.json')
})

afterEach(() => {
  for (const child of running.splice(0)) child.kill('SIGKILL')
  rmSync(root, { recursive: true, force: true })
})

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { XDG_DATA_HOME: _dataHome, ...rest } = process.env
  return {
    ...rest,
    HOME: home,
    OSTIA_RELEASE_DOWNLOAD_BASE_URL: `file://${join(root, 'release')}`,
    ...extra,
  }
}

function run(script: string, args: string[] = [], extra: Record<string, string> = {}) {
  const result = spawnSync('sh', [script, ...args], {
    env: env(extra),
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function runPiped(args: string[]) {
  const result = spawnSync('sh', ['-s', '--', ...args], {
    env: env(),
    input: readFileSync(installScript),
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

function unpackedApp(version: string): string {
  const dir = join(root, 'build', `ostia-${version}-linux-x64`)
  mkdirSync(join(dir, 'resources', 'icons'), { recursive: true })
  copyFileSync(realpathSync('/bin/sh'), join(dir, 'ostia'))
  copyFileSync(userInstallScript, join(dir, 'resources', 'user-install.sh'))
  writeFileSync(join(dir, 'resources', 'icons', '16x16.png'), 'png')
  writeFileSync(join(dir, 'resources', 'icon.svg'), '<svg/>')
  writeFileSync(join(dir, 'resources', 'build-info.json'), JSON.stringify({ version }))
  return dir
}

function publish(version: string, sums?: (archive: string, sum: string) => string): void {
  const dir = unpackedApp(version)
  const archive = `ostia-${version}-linux-x64.tar.gz`
  const out = join(releases, 'download', `v${version}`)
  mkdirSync(out, { recursive: true })
  const packed = spawnSync('tar', [
    '-C',
    join(root, 'build'),
    '-czf',
    join(out, archive),
    `ostia-${version}-linux-x64`,
  ])
  expect(packed.status).toBe(0)
  const sum = createHash('sha256')
    .update(readFileSync(join(out, archive)))
    .digest('hex')
  const other = `${'0'.repeat(64)}  ostia_${version}_amd64.deb\n`
  writeFileSync(
    join(out, 'SHA256SUMS'),
    other + (sums ? sums(archive, sum) : `${sum}  ${archive}\n`),
  )
  rmSync(dir, { recursive: true })
}

function markLatest(version: string): void {
  const latest = join(releases, 'latest', 'download')
  mkdirSync(latest, { recursive: true })
  copyFileSync(join(releases, 'download', `v${version}`, 'SHA256SUMS'), join(latest, 'SHA256SUMS'))
}

function installedVersion(): string {
  return JSON.parse(readFileSync(join(app, 'resources', 'build-info.json'), 'utf8')).version
}

function install(version: string): void {
  publish(version)
  expect(run(installScript, ['--version', version]).status).toBe(0)
}

function expectNoLeftovers(): void {
  expect(existsSync(`${app}.new`)).toBe(false)
  expect(existsSync(`${app}.old`)).toBe(false)
}

describe.skipIf(!linux)('packaging/linux/install.sh', () => {
  it('installs the latest release for the user in the install:local layout', () => {
    publish('1.2.3')
    publish('1.2.4')
    markLatest('1.2.4')
    mkdirSync(join(home, '.config', 'ostia'), { recursive: true })
    writeFileSync(settings, '{}')

    const { status, stdout, stderr } = run(installScript)
    expect(stderr).toBe('')
    expect(status).toBe(0)
    expect(stdout).toContain('downloading ostia 1.2.4')
    expect(installedVersion()).toBe('1.2.4')
    expect(spawnSync(join(app, 'ostia'), ['-c', 'exit 0']).status).toBe(0)
    expect(readFileSync(desktopEntry, 'utf8')).toContain(`Exec=${app}/ostia %U`)
    expect(existsSync(icon)).toBe(true)
    expect(existsSync(scalableIcon)).toBe(true)
    expect(readFileSync(cli, 'utf8')).toContain(`'${app}/resources/app.asar/out/cli/index.js'`)
    expectNoLeftovers()
  })

  it('replaces an existing install with the pinned version when piped into sh', () => {
    install('1.2.4')
    publish('1.2.3')
    writeFileSync(join(app, 'stale'), '')
    const { status } = runPiped(['--version', 'v1.2.3'])
    expect(status).toBe(0)
    expect(installedVersion()).toBe('1.2.3')
    expect(existsSync(join(app, 'stale'))).toBe(false)
    expectNoLeftovers()
  })

  it('refuses an archive whose checksum does not match', () => {
    install('1.2.3')
    publish('1.2.5', (archive) => `${'a'.repeat(64)}  ${archive}\n`)
    const { status, stderr } = run(installScript, ['--version', '1.2.5'])
    expect(status).toBe(1)
    expect(stderr).toContain('checksum mismatch for ostia-1.2.5-linux-x64.tar.gz')
    expect(installedVersion()).toBe('1.2.3')
    expectNoLeftovers()
  })

  it('refuses a release whose checksums do not list the archive', () => {
    install('1.2.3')
    publish('1.2.6', () => '')
    const { status, stderr } = run(installScript, ['--version', '1.2.6'])
    expect(status).toBe(1)
    expect(stderr).toContain('lists no ostia-1.2.6-linux-x64.tar.gz')
    expect(installedVersion()).toBe('1.2.3')
  })

  it('refuses a version that was never released and a malformed one', () => {
    install('1.2.3')
    const missing = run(installScript, ['--version', 'v7.0.0'])
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('could not download')
    const malformed = run(installScript, ['--version', '../1.2.3'])
    expect(malformed.status).toBe(1)
    expect(malformed.stderr).toContain('is not a version')
    expect(installedVersion()).toBe('1.2.3')
  })

  it('refuses to install or uninstall while the app runs from that folder', async () => {
    install('1.2.3')
    const child = spawn(join(app, 'ostia'), ['-c', 'read line'], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    running.push(child)
    await new Promise((resolve) => child.once('spawn', resolve))
    for (const args of [[], ['--uninstall']]) {
      const { status, stderr } = run(installScript, args)
      expect(status).toBe(1)
      expect(stderr).toContain(`ostia is running from ${app}`)
    }
    expect(installedVersion()).toBe('1.2.3')
    const exited = new Promise((resolve) => child.once('exit', resolve))
    child.kill('SIGKILL')
    await exited
  })

  it('names what is missing on an unsupported system', () => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Darwin\n', { mode: 0o755 })
    const darwin = run(installScript, [], { PATH: `${bin}:${process.env.PATH}` })
    expect(darwin.status).toBe(1)
    expect(darwin.stderr).toContain('installs on Linux only, and this is Darwin')

    writeFileSync(join(bin, 'uname'), '#!/bin/sh\n[ "$1" = -m ] && echo aarch64 || echo Linux\n')
    const arm = run(installScript, [], { PATH: `${bin}:${process.env.PATH}` })
    expect(arm.status).toBe(1)
    expect(arm.stderr).toContain('only x64 builds are published, and this machine is aarch64')

    const fresh = join(root, 'fresh-home')
    const tools = join(root, 'tools')
    mkdirSync(fresh)
    mkdirSync(tools)
    const uname = spawnSync('sh', ['-c', 'command -v uname'], { encoding: 'utf8' }).stdout.trim()
    symlinkSync(uname, join(tools, 'uname'))
    const sh = realpathSync('/bin/sh')
    const noCurl = spawnSync(sh, [installScript], {
      env: { HOME: fresh, PATH: tools },
      encoding: 'utf8',
    })
    expect(noCurl.status).toBe(1)
    expect(noCurl.stderr).toContain('curl is required but was not found')
  })

  it('uninstalls exactly what it installed and keeps user data', () => {
    const kept = join(home, '.local', 'share', 'ostia', 'kept.json')
    const otherIcon = join(
      home,
      '.local',
      'share',
      'icons',
      'hicolor',
      '16x16',
      'apps',
      'other.png',
    )
    install('1.2.3')
    mkdirSync(join(home, '.config', 'ostia'), { recursive: true })
    writeFileSync(settings, '{}')
    writeFileSync(kept, '{}')
    writeFileSync(otherIcon, 'png')

    const { status, stdout } = run(installScript, ['--uninstall'])
    expect(status).toBe(0)
    expect(stdout).toContain(`removed ostia from ${app}`)
    for (const path of [app, desktopEntry, icon, scalableIcon, cli]) {
      expect(existsSync(path)).toBe(false)
    }
    expect(existsSync(kept)).toBe(true)
    expect(existsSync(otherIcon)).toBe(true)
    expect(existsSync(settings)).toBe(true)

    const again = run(installScript, ['--uninstall'])
    expect(again.status).toBe(1)
    expect(again.stderr).toContain('nothing to remove')
  })

  it('leaves a command it did not write in place', () => {
    install('1.2.3')
    writeFileSync(cli, '#!/bin/sh\necho mine\n')
    expect(run(installScript, ['--uninstall']).status).toBe(0)
    expect(readFileSync(cli, 'utf8')).toContain('echo mine')
  })
})

describe.skipIf(!linux)('packaging/linux/user-install.sh', () => {
  it('installs a copy of the unpacked build it ships in', () => {
    const dir = unpackedApp('2.0.0')
    const { status, stdout } = run(join(dir, 'resources', 'user-install.sh'))
    expect(status).toBe(0)
    expect(stdout).toContain(`installed ostia to ${app}`)
    expect(installedVersion()).toBe('2.0.0')
    expect(existsSync(join(dir, 'ostia'))).toBe(true)
    expect(readFileSync(cli, 'utf8')).toContain(`export OSTIA_APP_BIN='${app}/ostia'`)
    expectNoLeftovers()
  })
})

describe.skipIf(spawnSync('shellcheck', ['--version']).status !== 0)('shell scripts', () => {
  it('pass shellcheck', () => {
    const result = spawnSync(
      'shellcheck',
      [installScript, userInstallScript, localInstallScript, headersScript],
      {
        encoding: 'utf8',
      },
    )
    expect(result.stdout).toBe('')
    expect(result.status).toBe(0)
  })
})
