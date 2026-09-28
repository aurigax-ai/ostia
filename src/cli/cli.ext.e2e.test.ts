import { execFileSync, execSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { registerControlServer, stopControlServer } from '../main/controlServer'
import { ExtensionHost, registerExtensionMethods } from '../main/extensionHost'
import { ExtensionStore } from '../main/extensionStore'
import { type PaneIdentity, registerPane } from '../main/idRegistry'
import type { CommandResult } from '../shared/types'

const repoRoot = process.cwd()
const cliPath = join(repoRoot, 'out', 'cli', 'index.js')

interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

describe('pine CLI → built-in kanban/wiki extensions (real processes, real socket)', () => {
  let dir: string
  let workDir: string
  let socketPath: string
  let identity: PaneIdentity
  let host: ExtensionHost
  const savedDataHome = process.env.XDG_DATA_HOME

  function runPine(args: string[], input?: string): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [cliPath, ...args], {
        env: { ...process.env, PINE_SOCKET: socketPath, PINE_TOKEN: identity.token },
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        reject(new Error(`pine ${args.join(' ')} timed out (${stdout} ${stderr})`))
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
      child.stdin.end(input ?? '')
    })
  }

  beforeAll(() => {
    execSync('pnpm run build:cli && pnpm run build:extensions', { cwd: repoRoot, stdio: 'ignore' })
    dir = mkdtempSync(join(tmpdir(), 'pine-cli-ext-'))
    workDir = join(dir, 'project')
    process.env.XDG_DATA_HOME = join(dir, 'data')
    socketPath = join(dir, 'control.sock')
    identity = registerPane({ windowId: 'w1', sessionId: 's1', paneId: 'pCliExt' })
    host = new ExtensionHost({
      roots: [{ dir: join(repoRoot, 'out', 'extensions'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForSession: (sid) => (sid === 's1' ? workDir : undefined),
      broadcast: () => {},
      openPanelIn: () => {},
      notify: () => {},
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
    rmSync(dir, { recursive: true, force: true })
  })

  it('pine kanban add/ls/done keep their old output, stored in the project board', async () => {
    const add = await runPine(['kanban', 'add', 'Ship it', '--column', 'doing', '--body', 'b'])
    expect(add.stderr).toBe('')
    expect(add.code).toBe(0)
    expect(JSON.parse(add.stdout)).toMatchObject({
      id: 'card-1',
      title: 'Ship it',
      column: 'doing',
    })

    const done = await runPine(['kanban', 'done', 'card-1'])
    expect(done.stdout.trim()).toBe('ok')

    const ls = await runPine(['kanban', 'ls'])
    expect(ls.code).toBe(0)
    expect(ls.stdout).toContain('# Done (done)\n  card-1\tShip it')
    expect(ls.stdout).toContain('# Todo (todo)\n  (empty)')

    const board = JSON.parse(readFileSync(join(workDir, '.pine', 'board.json'), 'utf8'))
    expect(board.cards).toHaveLength(1)
  }, 30_000)

  it('pine wiki set reads stdin, and get/ls/search read it back', async () => {
    const set = await runPine(['wiki', 'set', 'notes'], 'hello **pine**')
    expect(set.stderr).toBe('')
    expect(set.stdout.trim()).toBe('ok')
    expect((await runPine(['wiki', 'get', 'notes'])).stdout.trim()).toBe('hello **pine**')
    expect((await runPine(['wiki', 'ls'])).stdout).toMatch(/^notes\tnotes\t/)
    expect((await runPine(['ext', 'wiki', 'search', 'pine'])).stdout).toContain('notes\tnotes\t')
  }, 30_000)

  it('global wiki writes still need workspace-wide', async () => {
    const res = await runPine(['wiki', 'set', 'shared', '--global'], 'x')
    expect(res.code).toBe(1)
    expect(res.stderr).toContain('needs-elevation: workspace-wide')
    expect(existsSync(join(dir, 'data', 'pine', 'wiki.json'))).toBe(false)
  }, 30_000)

  it('reports argument errors and unknown extensions with a non-zero exit', async () => {
    const missing = await runPine(['kanban', 'move', 'card-1'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('invalid-args: move <id> <column>')
    const unknown = await runPine(['nosuchext', 'go'])
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toContain("unknown command or extension 'nosuchext'")
  }, 30_000)

  it('pine git status/changes/diff print JSON for the session repo', async () => {
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

    const status = await runPine(['git', 'status'])
    expect(status.stderr).toBe('')
    expect(JSON.parse(status.stdout)).toMatchObject({
      root: realpathSync(workDir),
      branch: { head: 'trunk' },
      counts: { changed: 1 },
    })

    const changes = JSON.parse((await runPine(['git', 'changes'])).stdout)
    expect(changes.changes).toContainEqual({ path: 'readme.md', area: 'unstaged', code: 'M' })

    const diff = JSON.parse((await runPine(['git', 'diff', 'readme.md'])).stdout)
    expect(diff).toMatchObject({ path: 'readme.md', area: 'unstaged' })
    expect(diff.patch).toContain('-v1\n+v2')
  }, 30_000)

  it('pine ext ls lists the built-in extensions with their CLI usage', async () => {
    const res = await runPine(['ext', 'ls'])
    expect(res.stdout).toContain('kanban\t')
    expect(res.stdout).toContain('pine kanban add "<title>" [--column X] [--body ...]')
    expect(res.stdout).toContain('pine wiki set <slug> [--global]')
  }, 30_000)
})
