import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerControlServer, stopControlServer } from '../main/controlServer'
import {
  type ExtensionConfirmRequest,
  ExtensionHost,
  type TerminalOpenRequest,
  registerExtensionMethods,
} from '../main/extensionHost'
import { ExtensionStore } from '../main/extensionStore'
import { type PaneIdentity, registerPane } from '../main/idRegistry'
import type { CommandResult } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')
const fakeSshBin = join(repoRoot, 'test', 'fixtures', 'ssh', 'bin')
const captures = join(repoRoot, 'test', 'fixtures', 'ssh')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

describe('ostia ssh (real extension process, real socket, fake ssh)', () => {
  let dir: string
  let sshLog: string
  let socketPath: string
  let identity: PaneIdentity
  let host: ExtensionHost
  const saved = {
    dataHome: process.env.XDG_DATA_HOME,
    path: process.env.PATH,
    home: process.env.HOME,
    sshDir: process.env.FAKE_SSH_DIR,
    sshLog: process.env.FAKE_SSH_LOG,
    remoteShell: process.env.FAKE_SSH_REMOTE_SHELL,
    remoteHome: process.env.FAKE_SSH_REMOTE_HOME,
  }
  let remoteHome: string
  const confirm = vi.fn<(req: ExtensionConfirmRequest) => Promise<boolean>>()
  const openTerminalIn = vi.fn<(req: TerminalOpenRequest) => Promise<string | null>>()

  function restore(name: string, value: string | undefined): void {
    if (value === undefined) Reflect.deleteProperty(process.env, name)
    else process.env[name] = value
  }

  function runOstia(args: string[]): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, OSTIA_SOCKET: socketPath, OSTIA_TOKEN: identity.token },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`ostia ${args.join(' ')} timed out (${stdout} ${stderr})`))
      }, 15_000)
      child.stdout.on('data', (c: Buffer) => {
        stdout += c.toString()
      })
      child.stderr.on('data', (c: Buffer) => {
        stderr += c.toString()
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr })
      })
      child.stdin.on('error', () => {})
      child.stdin.end('')
    })
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-cli-ssh-'))
    const home = join(dir, 'home')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'config'), 'Host db\n  HostName 10.0.0.5\n\nHost px\n')
    sshLog = join(dir, 'ssh-calls.log')
    process.env.XDG_DATA_HOME = join(dir, 'data')
    process.env.HOME = home
    process.env.PATH = `${fakeSshBin}:${saved.path}`
    process.env.FAKE_SSH_DIR = captures
    process.env.FAKE_SSH_LOG = sshLog
    remoteHome = join(dir, 'remote-home')
    mkdirSync(remoteHome)
    process.env.FAKE_SSH_REMOTE_SHELL = '/bin/sh'
    process.env.FAKE_SSH_REMOTE_HOME = remoteHome
    socketPath = join(dir, 'control.sock')
    identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pCliSsh' })
    host = new ExtensionHost({
      roots: [{ dir: join(repoRoot, 'out', 'extensions'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      dataDir: join(dir, 'ext-data'),
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      confirm,
      openTerminalIn,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
  }, 120_000)

  afterAll(() => {
    host.stopAll()
    stopControlServer()
    restore('XDG_DATA_HOME', saved.dataHome)
    restore('PATH', saved.path)
    restore('HOME', saved.home)
    restore('FAKE_SSH_DIR', saved.sshDir)
    restore('FAKE_SSH_LOG', saved.sshLog)
    restore('FAKE_SSH_REMOTE_SHELL', saved.remoteShell)
    restore('FAKE_SSH_REMOTE_HOME', saved.remoteHome)
    rmSync(dir, { recursive: true, force: true })
  })

  it('SSH-C1 ships ssh as a built-in with connect, ls and show, running without an approval', async () => {
    const listed = await runOstia(['ext', 'ls'])
    expect(listed.stdout).toContain('ssh\t')
    expect(listed.stdout).toContain(
      'ostia ssh connect [-J <hop>[,<hop>...]] [-p <port>] <[user@]host>',
    )
    expect(listed.stdout).toContain('ostia ssh ls')
    expect(listed.stdout).toContain('ostia ssh show <host>')
    const info = host.list().find((e) => e.id === 'ssh')
    expect(info).toMatchObject({
      builtin: true,
      enabled: true,
      granted: ['shell'],
      unapproved: [],
    })
    expect(info?.status).not.toBe('pending-approval')
  }, 30_000)

  it('SSH-C19 lists the aliases of the ssh config without running ssh', async () => {
    const res = await runOstia(['ssh', 'ls'])
    expect(res.stderr).toBe('')
    expect(JSON.parse(res.stdout)).toEqual({
      hosts: [{ alias: 'db' }, { alias: 'px' }],
      truncated: false,
    })
    expect(existsSync(sshLog)).toBe(false)
  }, 30_000)

  it('SSH-C20 shows one host as ssh resolves it', async () => {
    const res = await runOstia(['ssh', 'show', 'db'])
    expect(res.stderr).toBe('')
    expect(JSON.parse(res.stdout)).toEqual({
      alias: 'db',
      user: 'dev',
      hostname: '10.0.0.5',
      port: 2200,
      jump: ['b1', 'ops@b2:2222'],
      proxyCommand: false,
      remoteCommand: false,
    })
    expect(confirm).not.toHaveBeenCalled()
    expect(openTerminalIn).not.toHaveBeenCalled()
  }, 30_000)

  it('SSH-C56 refuses to install or remove the remote helper for an agent in a pane', async () => {
    const install = await runOstia(['ssh', 'helper-install', 'db'])
    expect(install.code).not.toBe(0)
    expect(`${install.stdout}${install.stderr}`).toContain('human-only')
    const remove = await runOstia(['ssh', 'helper-remove', 'db'])
    expect(`${remove.stdout}${remove.stderr}`).toContain('human-only')
    expect(confirm).not.toHaveBeenCalled()
    expect(existsSync(join(remoteHome, '.ostia'))).toBe(false)
    const listed = await runOstia(['ssh', 'helpers'])
    expect(JSON.parse(listed.stdout).hosts).toEqual([])
  }, 30_000)

  it('SSH-C42 installs the shipped helper script on the host once the human approves', async () => {
    confirm.mockResolvedValueOnce(true)
    const res = await host.invoke('ssh', 'helper-install', { argv: ['db'] }, host.userCaller(null))
    expect(res).toMatchObject({ ok: true, data: { host: 'db', protocol: 1, installed: true } })
    expect(confirm).toHaveBeenCalledTimes(1)
    const asked = confirm.mock.calls[0][0]
    expect(asked.message).toContain('db')
    expect(asked.detail).toContain('dev@10.0.0.5:2200')
    const versions = readdirSync(join(remoteHome, '.ostia', 'helper'))
    expect(versions).toHaveLength(1)
    expect(asked.detail).toContain(`~/.ostia/helper/${versions[0]}/helper.sh`)
    const shipped = readFileSync(join(repoRoot, 'out', 'extensions', 'ssh', 'assets', 'helper.sh'))
    const installed = readFileSync(join(remoteHome, '.ostia', 'helper', versions[0], 'helper.sh'))
    expect(installed.equals(shipped)).toBe(true)
    expect(readdirSync(join(remoteHome, '.ostia', 'helper', versions[0])).sort()).toContain(
      'session.sh',
    )
    expect(
      shipped.equals(readFileSync(join(repoRoot, 'src/extensions/ssh/assets/helper.sh'))),
    ).toBe(true)
    const answers = join(dir, 'ext-data', 'ssh', 'helper-hosts.json')
    expect(statSync(answers).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(answers, 'utf8')).hosts.db.answer).toBe('allowed')
    const listed = await runOstia(['ssh', 'helpers'])
    expect(JSON.parse(listed.stdout).hosts).toEqual([
      {
        host: 'db',
        answer: 'allowed',
        version: versions[0],
        current: true,
        installed: true,
        connected: true,
        folders: 0,
      },
    ])
    confirm.mockClear()
  }, 30_000)
})
