import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
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
const fakeSystemBin = join(repoRoot, 'test', 'fixtures', 'system', 'bin')
const REQUEST_TIMEOUT_MS = 3000

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

describe('ostia CLI → extensions (real processes, real socket)', () => {
  let dir: string
  let workDir: string
  let socketPath: string
  let identity: PaneIdentity
  let host: ExtensionHost
  const savedDataHome = process.env.XDG_DATA_HOME
  const savedPath = process.env.PATH
  const confirm = vi.fn<(req: ExtensionConfirmRequest) => Promise<boolean>>()
  const openTerminalIn = vi.fn<(req: TerminalOpenRequest) => Promise<string | null>>()

  function runOstia(args: string[], input?: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, PINE_SOCKET: socketPath, PINE_TOKEN: identity.token },
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
      child.stdin.end(input ?? '')
    })
  }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-cli-ext-'))
    workDir = join(dir, 'project')
    process.env.XDG_DATA_HOME = join(dir, 'data')
    process.env.PATH = `${fakeSystemBin}:${savedPath}`
    socketPath = join(dir, 'control.sock')
    identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pCliExt' })
    host = new ExtensionHost({
      roots: [
        { dir: join(repoRoot, 'out', 'extensions'), builtin: true },
        { dir: join(repoRoot, 'test', 'fixtures', 'extensions'), builtin: true },
      ],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: (sid) => (sid === 's1' ? workDir : undefined),
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
      confirm,
      openTerminalIn,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
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
    if (savedDataHome === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = savedDataHome
    process.env.PATH = savedPath
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    confirm.mockReset()
    openTerminalIn.mockReset()
  })

  it('passes stdin only to a command whose manifest asks for it', async () => {
    const piped = await runOstia(['echo', 'stdin'], 'hello **ostia**')
    expect(piped.stderr).toBe('')
    expect(piped.stdout.trim()).toBe('stdin:hello **ostia**')
    expect((await runOstia(['ext', 'echo', 'echo', 'a'], 'ignored')).stdout.trim()).toBe('echoed')
  }, 30_000)

  it('hands an extension command its arguments untouched, flags and -- included', async () => {
    const argv = ['--json', '-x', '--name=web', '--', '--pane', '-', '-5', 'two words']
    for (const prefix of [['echo'], ['ext', 'echo']]) {
      const res = await runOstia([...prefix, 'argv', ...argv])
      expect(res.stderr).toBe('')
      expect(JSON.parse(res.stdout)).toEqual(argv)
    }
  }, 30_000)

  it('reports argument errors and unknown extensions with a non-zero exit', async () => {
    const missing = await runOstia(['git', 'diff'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('invalid-args: diff <path> [--staged]')
    const unknown = await runOstia(['nosuchext', 'go'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown command or extension 'nosuchext'")
  }, 30_000)

  it('ostia git status/changes/diff print JSON for the workspace repo', async () => {
    const vcs = (...args: string[]) =>
      execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: workDir })
    mkdirSync(workDir, { recursive: true })
    vcs('init', '-q', '-b', 'trunk')
    vcs('config', 'user.email', 't@example.com')
    vcs('config', 'user.name', 'T')
    writeFileSync(join(workDir, 'readme.md'), 'v1\n')
    vcs('add', 'readme.md')
    vcs('commit', '-q', '-m', 'init')
    writeFileSync(join(workDir, 'readme.md'), 'v2\n')

    const status = await runOstia(['git', 'status'])
    expect(status.stderr).toBe('')
    expect(JSON.parse(status.stdout)).toMatchObject({
      root: realpathSync(workDir),
      branch: { head: 'trunk' },
      counts: { changed: 1 },
    })

    const changes = JSON.parse((await runOstia(['git', 'changes'])).stdout)
    expect(changes.changes).toContainEqual({ path: 'readme.md', area: 'unstaged', code: 'M' })

    const diff = JSON.parse((await runOstia(['git', 'diff', 'readme.md'])).stdout)
    expect(diff).toMatchObject({ path: 'readme.md', area: 'unstaged' })
    expect(diff.patch).toContain('-v1\n+v2')
  }, 30_000)

  it('ostia git stage/commit/log/blame work on the workspace repo; discard is not a verb', async () => {
    const staged = await runOstia(['git', 'stage', 'readme.md'])
    expect(staged.stderr).toBe('')
    expect(JSON.parse(staged.stdout)).toMatchObject({
      staged: ['readme.md'],
      counts: { staged: 1 },
    })

    const committed = await runOstia(['git', 'commit', '-m', 'second version'])
    expect(committed.stderr).toBe('')
    expect(committed.stdout.trim()).toMatch(/^[0-9a-f]{40}$/)

    const log = await runOstia(['git', 'log'])
    expect(log.stdout.split('\n').map((l) => l.replace(/^\w+ \S+ /, ''))).toEqual([
      'T  second version',
      'T  init',
      '',
    ])
    const logJson = JSON.parse((await runOstia(['git', 'log', '--limit', '1', '--json'])).stdout)
    expect(logJson.commits).toHaveLength(1)
    expect(logJson.commits[0]).toMatchObject({
      sha: committed.stdout.trim(),
      subject: 'second version',
    })

    const blame = JSON.parse((await runOstia(['git', 'blame', 'readme.md', '--json'])).stdout)
    expect(blame.lines).toEqual([
      expect.objectContaining({ line: 1, sha: committed.stdout.trim(), text: 'v2' }),
    ])

    const nothing = await runOstia(['git', 'unstage'])
    expect(nothing.code).toBe(1)
    expect(nothing.stderr).toContain('invalid-args')
    const discard = await runOstia(['git', 'discard', 'readme.md'])
    expect(discard.code).toBe(1)
    expect(discard.stderr).toContain("unknown subcommand 'discard'")
  }, 30_000)

  it('ostia ext ls lists the built-in extensions with their CLI usage', async () => {
    const res = await runOstia(['ext', 'ls'])
    expect(res.stdout).toContain('git\t')
    expect(res.stdout).toContain('ostia git diff <path> [--staged]')
    expect(res.stdout).toContain('ostia git commit -m <message>')
    expect(res.stdout).not.toContain('discard')
    expect(res.stdout).toContain('system\t')
    expect(res.stdout).not.toContain('trellis\t')
    expect(res.stdout).not.toContain('kanban\t')
  }, 30_000)

  describe('ostia system', () => {
    const sudo = process.getuid?.() === 0 ? '' : 'sudo '

    it('prints the OS, kernel, shell and the package managers on PATH as JSON', async () => {
      const res = await runOstia(['system', 'info'])
      expect(res.stderr).toBe('')
      const info = JSON.parse(res.stdout)
      expect(info.os).toMatchObject({ platform: process.platform })
      expect(typeof info.os.id).toBe('string')
      expect(info.kernel).toBeTruthy()
      expect(info.arch).toBe(process.arch)
      expect(info.packageManagers.available).toEqual(expect.arrayContaining(['pacman', 'apt']))
      expect(info.packageManagers.available).toContain(info.packageManagers.default)
    }, 30_000)

    it('waits for the human past the request timeout, then opens the command beside the agent', async () => {
      confirm.mockImplementation(
        () => new Promise((r) => setTimeout(() => r(true), REQUEST_TIMEOUT_MS + 1000)),
      )
      openTerminalIn.mockResolvedValue('installer-pane')
      const res = await runOstia([
        'system',
        'install',
        'ripgrep',
        'fd',
        '--manager',
        'pacman',
        '--reason',
        'faster search',
      ])
      expect(res.stderr).toBe('')
      expect(res.code).toBe(0)
      const command = `${sudo}pacman -S --needed ripgrep fd`
      expect(JSON.parse(res.stdout)).toEqual({ approved: true, command, paneId: 'installer-pane' })
      expect(confirm).toHaveBeenCalledTimes(1)
      const asked = confirm.mock.calls[0][0]
      expect(asked).toMatchObject({
        extId: 'system',
        title: 'Install system packages',
        confirmLabel: 'Approve',
        cancelLabel: 'Deny',
      })
      expect(asked.message).toContain('ripgrep, fd')
      expect(asked.detail).toContain(command)
      expect(asked.detail).toContain('faster search')
      expect(openTerminalIn).toHaveBeenCalledWith(
        expect.objectContaining({
          command,
          afterPaneId: 'pCliExt',
          workspaceId: 's1',
          windowId: 'w1',
        }),
      )
    }, 30_000)

    it('exits non-zero with approved false and opens nothing when the human denies', async () => {
      confirm.mockResolvedValue(false)
      const res = await runOstia(['system', 'install', 'ripgrep', '--manager', 'apt'])
      expect(res.code).toBe(1)
      expect(JSON.parse(res.stdout)).toEqual({
        approved: false,
        command: `${sudo}apt install ripgrep`,
      })
      expect(res.stderr).toContain('denied')
      expect(openTerminalIn).not.toHaveBeenCalled()
    }, 30_000)

    it('rejects a package name that could smuggle a flag or shell syntax before asking', async () => {
      for (const bad of ['--noconfirm', 'rg;reboot']) {
        const res = await runOstia(['system', 'install', 'ripgrep', bad, '--manager', 'pacman'])
        expect(res.code).toBe(1)
        expect(res.stderr).toContain('invalid-package')
      }
      expect(confirm).not.toHaveBeenCalled()
      expect(openTerminalIn).not.toHaveBeenCalled()
    }, 30_000)
  })
})
