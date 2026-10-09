import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerControlServer, stopControlServer } from '../main/control/controlServer'
import { type PaneIdentity, registerPane } from '../main/control/idRegistry'
import { GitCommands } from '../main/git/commands'
import { registerGitMethods } from '../main/git/register'
import { ViewStateStore } from '../main/git/viewState'
import { registerPortsMethods } from '../main/ports/register'
import { PortsService } from '../main/ports/service'
import { en } from '../shared/app/dict'
import { DEFAULT_GIT_SETTINGS } from '../shared/boards/git'
import { DEFAULT_PORTS_SETTINGS } from '../shared/boards/ports'
import type { CommandResult } from '../shared/types'

const cliPath = join(process.cwd(), 'out', 'cli', 'index.js')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

describe('ostia git and ostia ports (real CLI process, real socket)', () => {
  let dir: string
  let workDir: string
  let socketPath: string
  let identity: PaneIdentity
  const confirmDiscard = vi.fn<() => Promise<boolean>>()
  const openDiff = vi.fn()

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
      child.stdin.end('')
    })
  }

  const vcs = (...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: workDir })

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostia-cli-boards-'))
    workDir = join(dir, 'project')
    socketPath = join(dir, 'control.sock')
    identity = registerPane({ windowId: 'w1', workspaceId: 's1', paneId: 'pCliBoards' })
    mkdirSync(workDir, { recursive: true })
    vcs('init', '-q', '-b', 'trunk')
    vcs('config', 'user.email', 't@example.com')
    vcs('config', 'user.name', 'T')
    writeFileSync(join(workDir, 'readme.md'), 'v1\n')
    vcs('add', 'readme.md')
    vcs('commit', '-q', '-m', 'init')
    writeFileSync(join(workDir, 'readme.md'), 'v2\n')

    registerGitMethods({
      commands: new GitCommands({
        settings: () => DEFAULT_GIT_SETTINGS,
        text: () => en.git,
        cwdOf: async () => null,
        views: new ViewStateStore(null),
        openDiff,
        confirmDiscard,
        touched: () => {},
      }),
      callerOf: (pane) => ({ workspaceId: pane.workspaceId, workDir }),
    })
    registerPortsMethods(
      new PortsService({
        settings: () => DEFAULT_PORTS_SETTINGS,
        listPanes: async () => [
          {
            paneId: 'a',
            workspaceId: 's1',
            kind: 'terminal',
            title: 'a',
            running: true,
            blockCount: 0,
            pid: 10,
          },
          {
            paneId: 'b',
            workspaceId: 's2',
            kind: 'terminal',
            title: 'b',
            running: true,
            blockCount: 0,
            pid: 20,
          },
        ],
        rendererPaneId: (id) => id,
        send: () => {},
        scan: async () =>
          new Map([
            [10, { ports: [3000], ssh: null }],
            [20, { ports: [8080], ssh: { host: 'box' } }],
          ]),
      }),
    )
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
        isSandboxed: () => false,
      },
      socketPath,
    )
  }, 120_000)

  afterAll(() => {
    stopControlServer()
    rmSync(dir, { recursive: true, force: true })
  })

  it('prints status, changes and a diff as JSON for the workspace repository', async () => {
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

  it('opens a diff for the human through the window, not in the terminal', async () => {
    const res = await runOstia(['git', 'open', 'readme.md'])
    expect(res.stderr).toBe('')
    expect(JSON.parse(res.stdout)).toEqual({ opened: 'readme.md', area: 'unstaged' })
    expect(openDiff).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 's1',
        title: 'readme.md (unstaged)',
        original: 'v1\n',
        modified: 'v2\n',
      }),
    )
  }, 30_000)

  it('stages, commits, logs and blames; text for people and JSON with --json', async () => {
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
    const text = await runOstia(['git', 'blame', 'readme.md'])
    expect(text.stdout).toMatch(/^1 [0-9a-f]{8} \d{4}-\d{2}-\d{2} T\tv2\n$/)
  }, 30_000)

  it('exits 1 with the reason for missing arguments', async () => {
    const diff = await runOstia(['git', 'diff'])
    expect(diff.code).toBe(1)
    expect(diff.stderr).toContain('invalid-args: diff <path> [--staged]')
    const unstage = await runOstia(['git', 'unstage'])
    expect(unstage.code).toBe(1)
    expect(unstage.stderr).toContain('invalid-args')
    const commit = await runOstia(['git', 'commit'])
    expect(commit.code).toBe(1)
    expect(commit.stderr).toContain('invalid-args')
  }, 30_000)

  it('has no discard verb and no discard socket method', async () => {
    writeFileSync(join(workDir, 'readme.md'), 'v3\n')
    const verb = await runOstia(['git', 'discard', 'readme.md'])
    expect(verb.code).toBe(1)
    expect(verb.stderr).toContain('usage: ostia git <command>')
    expect(verb.stderr).not.toContain('discard')
    const method = await runOstia(['git.discard', '{"paths":["readme.md"],"all":false}'])
    expect(method.code).not.toBe(0)
    expect(confirmDiscard).not.toHaveBeenCalled()
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: workDir }).toString()).toContain(
      'readme.md',
    )
  }, 30_000)

  it('lists the ports of the caller workspace, and asks before listing every workspace', async () => {
    const own = await runOstia(['ports', 'ls'])
    expect(own.stderr).toBe('')
    expect(JSON.parse(own.stdout)).toEqual({
      workspaces: [{ workspaceId: 's1', ports: [3000], ssh: [] }],
    })
    const all = await runOstia(['ports', 'ls', '--all'])
    expect(all.code).not.toBe(0)
    expect(all.stderr).toContain('all-workspaces')
    const unknown = await runOstia(['ports', 'open'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain('usage: ostia ports ls [--all]')
  }, 30_000)
})
