import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runTool } from '@aurigax-ai/ostia-extension-sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FAKE_SSH_DIR, type RemoteHost, remoteHost } from '../../../../test/fixtures/ssh/remoteHost'
import { skipWithoutTmux } from '../../../../test/tmux'
import { type RepoHandoff, repoIdOf, repoSlug } from '../../../shared/remote/remoteHandoff'
import {
  NODE_CLI,
  NODE_ENTRY,
  NODE_REPOS,
  NODE_TMUX_SOCKET,
  NODE_WORK,
} from '../../../shared/remote/remoteNode'
import { HelperConsent } from '../consent'
import { planConnect } from '../plan'
import { type NodeBundle, nodeBundle } from './bundle'
import { remoteFetch } from './fetch'
import { RemoteRegistry } from './registry'
import { RemoteFailure, RunnerClient } from './runnerClient'
import { remoteStart } from './start'

const ASSETS = resolve(__dirname, '../../../../out/extensions/ssh/assets/node')
const caller = { kind: 'user' as const, capabilities: [], workspaceId: 'w1' }

const GIT_IDENTITY = ['-c', 'user.email=a@b.c', '-c', 'user.name=t']

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' }).trim()
}

describe.skipIf(skipWithoutTmux)('work handoff over a fake ssh host', () => {
  let host: RemoteHost
  let bundle: NodeBundle
  let client: RunnerClient
  let local: string
  let scratch: string
  let repo: RepoHandoff
  const confirm = vi.fn(async () => true)
  const openTerminal = vi.fn(async () => ({ ok: true as const, paneId: 'local-pane' }))
  const openDiff = vi.fn(async () => ({ ok: true as const }))

  const sessions = (): string[] => {
    const ran = spawnSync(
      'tmux',
      ['-S', join(host.home, NODE_TMUX_SOCKET), 'list-sessions', '-F', '#{session_name}'],
      { encoding: 'utf8' },
    )
    return ran.stdout.split('\n').filter(Boolean)
  }

  const jobGit = (jobId: string, ...args: string[]): string =>
    git(join(host.home, NODE_WORK, repo.name, jobId), ...args)

  function deps(consenting = true) {
    const gitEnv = {
      ...process.env,
      ...host.env,
      PATH: `${join(FAKE_SSH_DIR, 'git-bin')}:${host.env.PATH}`,
    }
    return {
      translate: () => (key: string) => key,
      confirm: consenting ? confirm : async () => false,
      consent: new HelperConsent(null),
      openTerminal,
      openDiff,
      client: () => client,
      registry,
      git: (args: string[], cwd: string) =>
        runTool('git', args, { cwd, timeoutMs: 60_000, env: gitEnv }),
      retryMs: 1,
    }
  }

  const registry = new RemoteRegistry(null)

  beforeAll(async () => {
    scratch = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-handoff-')))
    const stubs = join(scratch, 'stubs')
    mkdirSync(stubs)
    writeFileSync(
      join(stubs, 'claude'),
      [
        '#!/bin/sh',
        '[ -f "$HOME/die" ] && exit 1',
        'echo "$PWD|$*" >>"$HOME/claude.runs"',
        '"$OSTIA_NODE" "$OSTIA_CLI" resume-token claude sess-1 </dev/null >/dev/null 2>&1',
        'exec sleep 300',
        '',
      ].join('\n'),
      { mode: 0o700 },
    )
    host = remoteHost({ path: `${stubs}:${process.env.PATH}` })
    bundle = nodeBundle(
      [NODE_ENTRY, NODE_CLI].map((name) => ({ name, data: readFileSync(join(ASSETS, name)) })),
    )
    const plan = planConnect(['fakehost'])
    if (!plan) throw new Error('no plan')
    client = new RunnerClient(plan, bundle, {
      spawn: host.spawn,
      requestTimeoutMs: 30_000,
      helloTimeoutMs: 30_000,
    })
    registry.addWorkspace('w1', { host: 'fakehost', folder: '~', agent: 'claude' })
    local = join(scratch, 'proj')
    mkdirSync(local)
    git(local, 'init', '-q', '-b', 'main')
    writeFileSync(join(local, 'a.txt'), 'one\n')
    git(local, 'add', '.')
    git(local, 'commit', '-q', '-m', 'first')
    const name = repoSlug('proj')
    repo = {
      id: repoIdOf(name, git(local, 'rev-list', '--max-parents=0', 'HEAD')),
      name,
      head: git(local, 'rev-parse', 'HEAD'),
    }
    await client.install()
    await client.ensure()
  })

  afterAll(() => {
    spawnSync('tmux', ['-S', join(host.home, NODE_TMUX_SOCKET), 'kill-server'])
    host.cleanup()
    rmSync(scratch, { recursive: true, force: true })
  })

  async function pushJob(jobId: string): Promise<void> {
    await client.repoInit(repo.id)
    git(
      local,
      'push',
      '-q',
      join(host.home, NODE_REPOS, `${repo.id}.git`),
      `${repo.head}:refs/ostia/jobs/${jobId}`,
    )
  }

  const startInput = (jobId: string) => ({
    jobId,
    agent: 'claude' as const,
    prompt: 'do the thing',
    repo,
  })

  function remoteStartArgs(): { argv: string[] } {
    return {
      argv: [
        JSON.stringify({
          agent: 'claude',
          prompt: 'fix the bug',
          title: 'claude',
          workspaceId: 'w1',
          root: local,
          repo,
        }),
      ],
    }
  }
  it('RMT-C5 two starts with one job id, even at once, run one agent in the job worktree', async () => {
    await pushJob('aaaa0001')
    const [first, second] = await Promise.all([
      client.start(startInput('aaaa0001')),
      client.start(startInput('aaaa0001')),
    ])
    expect(first).toMatchObject({ status: 'started', jobId: 'aaaa0001', pane: 'aaaa0001' })
    expect(second).toEqual(first)
    expect(await client.start(startInput('aaaa0001'))).toMatchObject({
      status: 'started',
      session: 'sess-1',
    })
    expect(sessions().filter((name) => name === 'aaaa0001')).toHaveLength(1)
    expect((await client.jobs()).filter((job) => job.pane === 'aaaa0001')).toHaveLength(1)
    const runs = readFileSync(join(host.home, 'claude.runs'), 'utf8').trim().split('\n')
    expect(runs).toHaveLength(1)
    expect(runs[0]).toContain(`${join(host.home, NODE_WORK, repo.name, 'aaaa0001')}|`)
    expect(runs[0]).toContain('do the thing')
    expect(jobGit('aaaa0001', 'branch', '--show-current')).toBe('ostia/aaaa0001')
  })

  it('RMT-C6 answers failed when the agent ends before its start hook and keeps answering the same', async () => {
    await pushJob('aaaa0002')
    writeFileSync(join(host.home, 'die'), '')
    const failed = await client.start(startInput('aaaa0002'))
    expect(failed).toMatchObject({ status: 'failed', jobId: 'aaaa0002' })
    expect(failed.status === 'failed' ? failed.reason : '').toContain('before it started')
    expect(await client.start(startInput('aaaa0002'))).toEqual(failed)
    rmSync(join(host.home, 'die'))
    expect((await client.jobs()).find((job) => job.pane === 'aaaa0002')?.state).toBe('exited')
    expect(sessions().filter((name) => name === 'aaaa0002')).toHaveLength(1)
    await client.stop('aaaa0002')
  })

  it('RMT-C7 stops a job twice with the same answer and keeps the branch for fetching', async () => {
    await client.stop('aaaa0001')
    await expect(client.stop('aaaa0001')).resolves.toMatchObject({ stopped: 'aaaa0001' })
    expect(sessions()).not.toContain('aaaa0001')
    expect(await client.result('aaaa0001')).toMatchObject({
      branch: 'ostia/aaaa0001',
      repo: repo.id,
    })
  })

  it('RMT-C8 refuses a start whose commit was never pushed', async () => {
    await expect(client.start(startInput('aaaa0003'))).rejects.toBeInstanceOf(RemoteFailure)
    expect(sessions()).not.toContain('aaaa0003')
  })

  it('RMT-C9 remote-start asks once, pushes the commit under refs/ostia/jobs and opens the tab after the start hook', async () => {
    confirm.mockClear()
    git(local, 'config', 'push.followTags', 'true')
    git(local, 'tag', '-a', 'v1', '-m', 'v1')
    const command = remoteStart(deps())
    const first = await command(remoteStartArgs(), caller)
    expect(first).toMatchObject({ ok: true, data: { paneId: 'local-pane', session: 'sess-1' } })
    if (!first.ok) return
    const { jobId, ref } = first.data as { jobId: string; ref: string }
    expect(ref).toBe(`remote:fakehost:${jobId}`)
    const mirror = join(host.home, NODE_REPOS, `${repo.id}.git`)
    expect(git(mirror, 'rev-parse', `refs/ostia/jobs/${jobId}`)).toBe(repo.head)
    expect(git(mirror, 'for-each-ref', 'refs/tags')).toBe('')
    expect(git(mirror, 'for-each-ref', '--format=%(refname)')).toContain(`refs/ostia/jobs/${jobId}`)
    expect(sessions()).toContain(jobId)
    expect(openTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'w1', title: 'claude' }),
    )
    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm.mock.calls[0]).toMatchObject([{ title: 'pushTitle', message: 'pushMessage' }])
    const second = await command(remoteStartArgs(), caller)
    expect(second).toMatchObject({ ok: true })
    expect(confirm).toHaveBeenCalledTimes(1)
    await client.stop(jobId)
    if (second.ok) await client.stop((second.data as { jobId: string }).jobId)
  })

  it('RMT-C10 a start whose answer was lost is asked again with the same job id and runs once', async () => {
    const real = client
    let calls = 0
    const flaky = Object.create(real) as RunnerClient
    flaky.start = async (input) => {
      calls += 1
      const outcome = await real.start(input)
      if (calls === 1) throw new RemoteFailure('network', 'link dropped')
      return outcome
    }
    const command = remoteStart({ ...deps(), client: () => flaky })
    const res = await command(remoteStartArgs(), caller)
    expect(res).toMatchObject({ ok: true })
    expect(calls).toBe(2)
    if (!res.ok) return
    const { jobId } = res.data as { jobId: string }
    expect(sessions().filter((name) => name === jobId)).toHaveLength(1)
    await client.stop(jobId)
  })

  it('RMT-C11 remote-start sends nothing when the human refuses', async () => {
    const mirror = join(host.home, NODE_REPOS, `${repo.id}.git`)
    const jobs = () => git(mirror, 'for-each-ref', 'refs/ostia/jobs')
    const before = jobs()
    const res = await remoteStart(deps(false))(remoteStartArgs(), caller)
    expect(res).toMatchObject({ ok: false, error: 'refused' })
    expect(jobs()).toBe(before)
  })

  it('RMT-C12b remote-start refuses a sandboxed caller before asking or sending', async () => {
    confirm.mockClear()
    const res = await remoteStart(deps())(remoteStartArgs(), { ...caller, sandboxed: true })
    expect(res).toMatchObject({ ok: false, error: 'sandboxed' })
    expect(confirm).not.toHaveBeenCalled()
  })

  it('RMT-C12 remote-start is for the app only: a pane caller is refused', async () => {
    const res = await remoteStart(deps())(remoteStartArgs(), { ...caller, kind: 'pane' })
    expect(res).toMatchObject({ ok: false, error: 'human-only' })
  })

  describe('results', () => {
    let jobId = ''

    beforeAll(async () => {
      const res = await remoteStart(deps())(remoteStartArgs(), caller)
      if (!res.ok) throw new Error(res.message)
      jobId = (res.data as { jobId: string }).jobId
      writeFileSync(join(host.home, NODE_WORK, repo.name, jobId, 'b.txt'), 'two\n')
      jobGit(jobId, 'add', '.')
      jobGit(jobId, 'commit', '-q', '-m', 'agent work')
    })

    const fetchArgs = () => ({ argv: [`remote:fakehost:${jobId}`] })

    it('RMT-C13 fetches the branch into refs/remotes/ostia/<host>/<job>, prints every changed file and opens the diff, touching nothing else', async () => {
      const headBefore = git(local, 'rev-parse', 'HEAD')
      const branchBefore = git(local, 'branch', '--show-current')
      const res = await remoteFetch(deps())(fetchArgs(), { ...caller, cwd: local })
      const ref = `refs/remotes/ostia/fakehost/${jobId}`
      expect(res).toMatchObject({ ok: true, data: { ref } })
      expect(res.ok ? res.text : '').toContain(ref)
      expect(res.ok ? res.text : '').toContain('b.txt')
      expect(git(local, 'rev-parse', ref)).toBe(jobGit(jobId, 'rev-parse', 'HEAD'))
      expect(git(local, 'rev-parse', 'HEAD')).toBe(headBefore)
      expect(git(local, 'branch', '--show-current')).toBe(branchBefore)
      expect(git(local, 'status', '--porcelain')).toBe('')
      expect(openDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          original: '',
          modified: 'two\n',
          path: 'b.txt',
          workspaceId: 'w1',
        }),
      )
    })

    it('RMT-C14 says so when the remote worktree has edits that are not in the branch, and changes nothing there', async () => {
      writeFileSync(join(host.home, NODE_WORK, repo.name, jobId, 'c.txt'), 'loose\n')
      const res = await remoteFetch(deps())(fetchArgs(), { ...caller, cwd: local })
      expect(res).toMatchObject({ ok: true, data: { dirty: true } })
      expect(res.ok ? res.text : '').toContain('remoteDirty')
      expect(jobGit(jobId, 'status', '--porcelain')).toContain('c.txt')
    })

    it('RMT-C15 refuses a clone of another repository and a refused consent, fetching nothing', async () => {
      const other = join(scratch, 'other')
      mkdirSync(other)
      git(other, 'init', '-q', '-b', 'main')
      writeFileSync(join(other, 'x.txt'), 'x\n')
      git(other, 'add', '.')
      git(other, 'commit', '-q', '-m', 'x')
      const wrong = await remoteFetch(deps())(fetchArgs(), { ...caller, cwd: other })
      expect(wrong).toMatchObject({ ok: false, error: 'wrong-repo' })
      expect(
        spawnSync('git', ['-C', other, 'for-each-ref', 'refs/remotes'], { encoding: 'utf8' })
          .stdout,
      ).toBe('')
      const refused = await remoteFetch(deps(false))(fetchArgs(), { ...caller, cwd: local })
      expect(refused).toMatchObject({ ok: false, error: 'refused' })
    })

    it('RMT-C16 refuses a sandboxed caller and a ref that is not a remote job', async () => {
      expect(
        await remoteFetch(deps())(fetchArgs(), { ...caller, cwd: local, sandboxed: true }),
      ).toMatchObject({
        ok: false,
        error: 'sandboxed',
      })
      expect(
        await remoteFetch(deps())({ argv: ['nope'] }, { ...caller, cwd: local }),
      ).toMatchObject({
        ok: false,
        error: 'invalid-args',
      })
    })
  })
})
