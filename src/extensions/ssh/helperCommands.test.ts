import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type RemoteHost, helperSource, remoteHost } from '../../../test/fixtures/ssh/remoteHost'
import type { ExtensionCaller } from '../../shared/extensions'
import type { ConfirmRequest, ExtensionResult, OpenFolderOptions, OpenFolderResult } from '../sdk'
import { HelperConsent } from './consent'
import { HelperFolders, Sessions } from './folders'
import { shippedHelper } from './helper'
import { type HelperDeps, helperCommands, installedHelper } from './helperCommands'
import { HelperHosts } from './helperHosts'
import { type ConnectPlan, planConnect } from './plan'

const helper = shippedHelper(helperSource())
const DB = 'user dev\nhostname 10.0.0.5\nport 22\n'
const USER: ExtensionCaller = { kind: 'user', capabilities: [], workspaceId: 'w1', paneId: 'p1' }

interface Rig {
  remote: RemoteHost
  deps: HelperDeps
  consent: HelperConsent
  hosts: HelperHosts
  confirms: ConfirmRequest[]
  sshG: string[][]
  sessions: Sessions
  folders: HelperFolders
  asked: OpenFolderOptions[]
  closed: string[]
  answerFolder: (result: OpenFolderResult) => void
  run: (command: string, argv: string[], caller?: ExtensionCaller) => Promise<ExtensionResult>
}

const rigs: Rig[] = []

function planned(argv: string[]): ConnectPlan {
  const plan = planConnect(argv)
  if (!plan) throw new Error('plan')
  return plan
}

function errorOf(res: ExtensionResult): string | null {
  return res.ok ? null : res.error
}

function messageOf(res: ExtensionResult): string {
  return res.ok ? '' : (res.message ?? '')
}

function rig(over: { answer?: boolean; enabled?: boolean } = {}): Rig {
  const remote = remoteHost()
  const consent = new HelperConsent(join(remote.home, '..', 'local', 'helper-hosts.json'))
  const hosts = new HelperHosts({ helper, spawn: remote.spawn })
  const confirms: ConfirmRequest[] = []
  const sshG: string[][] = []
  const closed: string[] = []
  const asked: OpenFolderOptions[] = []
  const sessions = new Sessions()
  const folders = new HelperFolders(hosts)
  let folderAnswer: OpenFolderResult = { ok: true, folderId: 'folder000001' }
  const deps: HelperDeps = {
    run: async (args) => {
      sshG.push(args)
      return { code: 0, stdout: DB, stderr: '', missing: false, timedOut: false }
    },
    confirm: async (req) => {
      confirms.push(req)
      return over.answer ?? true
    },
    enabled: async () => over.enabled ?? true,
    consent,
    hosts,
    helper,
    now: () => new Date('2026-10-02T00:00:00Z'),
    sessions,
    folders,
    openFolder: async (opts) => {
      asked.push(opts)
      return folderAnswer
    },
    closeFolder: async (folderId) => {
      closed.push(folderId)
    },
  }
  const commands = helperCommands(deps)
  const made: Rig = {
    remote,
    deps,
    consent,
    hosts,
    confirms,
    sshG,
    sessions,
    folders,
    asked,
    closed,
    answerFolder: (result) => {
      folderAnswer = result
    },
    run: async (command, argv, caller = USER) =>
      commands[command as keyof typeof commands]({ argv }, caller),
  }
  rigs.push(made)
  return made
}

afterEach(() => {
  for (const made of rigs.splice(0)) {
    made.hosts.closeAll()
    made.remote.cleanup()
  }
})

function installedFile(remote: RemoteHost): string {
  return join(remote.home, '.ostia', 'helper', helper.version, 'helper.sh')
}

describe('helper-install', () => {
  it('SSH-C52 asks once with the host and the exact path, then installs and connects', async () => {
    const r = rig()
    const res = await r.run('helper-install', ['dev@db'])
    expect(res).toEqual({
      ok: true,
      data: {
        host: 'dev@db',
        version: helper.version,
        protocol: 1,
        path: `~/.ostia/helper/${helper.version}/helper.sh`,
        installed: true,
      },
    })
    expect(r.confirms).toHaveLength(1)
    expect(r.confirms[0].message).toContain('dev@db')
    expect(r.confirms[0].detail).toContain('dev@10.0.0.5:22')
    expect(r.confirms[0].detail).toContain(`~/.ostia/helper/${helper.version}/helper.sh`)
    expect(r.confirms[0].detail).toContain('never with sudo')
    expect(readFileSync(installedFile(r.remote)).equals(helper.source)).toBe(true)
    expect(r.consent.get('dev@db')).toEqual({
      answer: 'allowed',
      version: helper.version,
      installed: true,
      at: '2026-10-02T00:00:00.000Z',
    })
    expect(installedHelper(planned(['dev@db']), r.deps)).toBe(helper)
    expect(installedHelper(planned(['web']), r.deps)).toBeNull()
    expect(r.hosts.isConnected('dev@db')).toBe(true)

    const again = await r.run('helper-install', ['dev@db'])
    expect(again.ok && (again.data as { installed: boolean }).installed).toBe(false)
    expect(r.confirms).toHaveLength(1)
  })

  it('installs again without asking when the allowed helper is gone from the host', async () => {
    const r = rig()
    r.consent.set('dev@db', { answer: 'allowed', version: helper.version, at: '' })
    const res = await r.run('helper-install', ['dev@db'])
    expect(res.ok && (res.data as { installed: boolean }).installed).toBe(true)
    expect(r.confirms).toHaveLength(0)
    expect(existsSync(installedFile(r.remote))).toBe(true)
  })

  it('asks again when the stored consent is for another helper version', async () => {
    const r = rig()
    r.consent.set('dev@db', { answer: 'allowed', version: '000000000000', at: '' })
    await r.run('helper-install', ['dev@db'])
    expect(r.confirms).toHaveLength(1)
    expect(r.consent.get('dev@db')?.version).toBe(helper.version)
  })

  it('SSH-C53 installs nothing when the human refuses, and does not ask that host again', async () => {
    const r = rig({ answer: false })
    const res = await r.run('helper-install', ['dev@db'])
    expect(res.ok).toBe(false)
    expect(errorOf(res)).toBe('helper-refused')
    expect(messageOf(res)).toContain('SSH: Remove Remote Helper')
    expect(existsSync(join(r.remote.home, '.ostia'))).toBe(false)
    expect(r.remote.runs()).toEqual([])
    expect(r.consent.get('dev@db')?.answer).toBe('refused')
    const again = await r.run('helper-install', ['dev@db'])
    expect(errorOf(again)).toBe('helper-refused')
    expect(r.confirms).toHaveLength(1)
  })

  it('SSH-C74 keeps the answer but not the installed mark when the install fails', async () => {
    const r = rig()
    r.deps.hosts = new HelperHosts({
      helper,
      spawn: () => spawn('sh', ['-c', 'echo "PINE-HELPER needs cksum"'], { stdio: 'pipe' }),
    })
    const res = await helperCommands(r.deps)['helper-install']({ argv: ['dev@db'] }, USER)
    expect(errorOf(res)).toBe('needs-tool')
    expect(messageOf(res)).toContain('cksum')
    expect(r.consent.get('dev@db')).toEqual({
      answer: 'allowed',
      version: helper.version,
      at: '2026-10-02T00:00:00.000Z',
    })
    expect(installedHelper(planned(['dev@db']), r.deps)).toBeNull()
  })

  it('SSH-C73 does not count a refused host or another helper version as installed', () => {
    const r = rig()
    r.consent.set('web', { answer: 'refused', at: '' })
    r.consent.set('old', { answer: 'allowed', version: '000000000000', installed: true, at: '' })
    r.consent.set('new', { answer: 'allowed', version: helper.version, installed: true, at: '' })
    expect(installedHelper(planned(['web']), r.deps)).toBeNull()
    expect(installedHelper(planned(['old']), r.deps)).toBeNull()
    expect(installedHelper(planned(['new']), r.deps)).toBe(helper)
  })

  it('SSH-C55 does nothing while the setting is off', async () => {
    const r = rig({ enabled: false })
    const res = await r.run('helper-install', ['dev@db'])
    expect(errorOf(res)).toBe('helper-off')
    expect(r.confirms).toHaveLength(0)
    expect(r.sshG).toEqual([])
    expect(r.remote.runs()).toEqual([])
  })

  it('SSH-C56 refuses an agent, a sandboxed caller and arguments ssh would read as options', async () => {
    const r = rig()
    const pane: ExtensionCaller = { kind: 'pane', capabilities: [], paneId: 'p1' }
    expect(errorOf(await r.run('helper-install', ['db'], pane))).toBe('human-only')
    expect(errorOf(await r.run('helper-remove', ['db'], pane))).toBe('human-only')
    expect(errorOf(await r.run('helper-install', ['db'], { ...USER, sandboxed: true }))).toBe(
      'sandboxed',
    )
    expect(errorOf(await r.run('helpers', [], { ...pane, sandboxed: true }))).toBe('sandboxed')
    expect(errorOf(await r.run('helper-install', ['-oProxyCommand=x', 'db']))).toBe('invalid-args')
    expect(errorOf(await r.run('helper-remove', []))).toBe('invalid-args')
    expect(r.confirms).toHaveLength(0)
    expect(r.remote.runs()).toEqual([])
  })

  it('reports a host that cannot be resolved or reached without storing a refusal', async () => {
    const r = rig()
    r.deps.run = async () => ({
      code: 255,
      stdout: '',
      stderr: 'ssh: Could not resolve hostname nope\n',
      missing: false,
      timedOut: false,
    })
    const res = await helperCommands(r.deps)['helper-install']({ argv: ['nope'] }, USER)
    expect(errorOf(res)).toBe('resolve-failed')
    expect(r.consent.all()).toEqual([])
  })
})

describe('helper-remove and helpers', () => {
  it('SSH-C57 closes the folders, removes the helper and forgets the host after a confirm', async () => {
    const r = rig()
    await r.run('helper-install', ['dev@db'])
    const listed = await r.run('helpers', [], { kind: 'pane', capabilities: [] })
    expect(listed.data).toEqual({
      version: helper.version,
      hosts: [
        {
          host: 'dev@db',
          answer: 'allowed',
          version: helper.version,
          current: true,
          installed: true,
          connected: true,
          folders: 0,
        },
      ],
    })
    const res = await r.run('helper-remove', ['dev@db'])
    expect(res).toEqual({ ok: true, data: { host: 'dev@db', removed: true, forgotten: true } })
    expect(r.confirms).toHaveLength(2)
    expect(r.confirms[1].message).toContain('dev@db')
    expect(existsSync(join(r.remote.home, '.ostia'))).toBe(false)
    expect(r.hosts.isConnected('dev@db')).toBe(false)
    expect((await r.run('helpers', [])).data).toEqual({ version: helper.version, hosts: [] })
    expect(r.closed).toEqual([])
  })

  it('keeps everything when the human cancels the removal', async () => {
    const r = rig()
    await r.run('helper-install', ['dev@db'])
    r.deps.confirm = async () => false
    const res = await helperCommands(r.deps)['helper-remove']({ argv: ['dev@db'] }, USER)
    expect(errorOf(res)).toBe('denied')
    expect(existsSync(installedFile(r.remote))).toBe(true)
    expect(r.consent.get('dev@db')?.answer).toBe('allowed')
  })

  it('only forgets a refused host, without asking or connecting', async () => {
    const r = rig()
    r.consent.set('web', { answer: 'refused', at: '' })
    const res = await r.run('helper-remove', ['web'])
    expect(res).toEqual({ ok: true, data: { host: 'web', removed: false, forgotten: true } })
    expect(r.confirms).toHaveLength(0)
    expect(r.remote.runs()).toEqual([])
    expect(r.consent.get('web')).toBeUndefined()
  })
})

function session(r: Rig, paneId = 'p1'): void {
  r.sessions.opened(paneId, planned(['dev@db']))
}

const REMOTE = { host: 'db1', cwd: '/srv/app' }

describe('open-folder', () => {
  it('SSH-C56 refuses an agent, a sandbox, a pane that is no session and a session without a remote folder', async () => {
    const r = rig()
    session(r)
    const pane: ExtensionCaller = { kind: 'pane', capabilities: [], paneId: 'p1', remote: REMOTE }
    expect(errorOf(await r.run('open-folder', [], pane))).toBe('human-only')
    expect(
      errorOf(await r.run('open-folder', [], { ...USER, remote: REMOTE, sandboxed: true })),
    ).toBe('sandboxed')
    expect(
      errorOf(await r.run('open-folder', [], { ...USER, paneId: 'other', remote: REMOTE })),
    ).toBe('not-a-session')
    expect(errorOf(await r.run('open-folder', [], USER))).toBe('no-remote-folder')
    expect(r.confirms).toHaveLength(0)
    expect(r.asked).toEqual([])
    expect(r.remote.runs()).toEqual([])
  })

  it('asks for consent on a new host, then asks core to open the folder the session is in', async () => {
    const r = rig()
    session(r)
    const res = await r.run('open-folder', [], { ...USER, remote: REMOTE })
    expect(res).toEqual({
      ok: true,
      data: { folderId: 'folder000001', host: 'dev@db', path: '/srv/app' },
    })
    expect(r.confirms).toHaveLength(1)
    expect(r.asked).toEqual([{ workspaceId: 'w1', host: 'dev@db', path: '/srv/app' }])
    expect(r.folders.idsOn('dev@db')).toEqual(['folder000001'])
    const listed = await r.run('helpers', [])
    expect(
      (listed.ok && (listed.data as { hosts: { folders: number }[] }).hosts[0].folders) || 0,
    ).toBe(1)
  })

  it('opens nothing when the human refuses the helper or the folder', async () => {
    const refusedHelper = rig({ answer: false })
    session(refusedHelper)
    const first = await refusedHelper.run('open-folder', [], { ...USER, remote: REMOTE })
    expect(errorOf(first)).toBe('helper-refused')
    expect(refusedHelper.asked).toEqual([])

    const r = rig()
    session(r)
    r.answerFolder({ ok: false, error: 'denied' })
    const res = await r.run('open-folder', [], { ...USER, remote: REMOTE })
    expect(errorOf(res)).toBe('denied')
    expect(r.folders.idsOn('dev@db')).toEqual([])
  })

  it('SSH-C57 closes the open folders of a host before its helper is removed', async () => {
    const r = rig()
    session(r)
    await r.run('open-folder', [], { ...USER, remote: REMOTE })
    const res = await r.run('helper-remove', ['dev@db'])
    expect(res.ok).toBe(true)
    expect(r.closed).toEqual(['folder000001'])
    expect(r.folders.idsOn('dev@db')).toEqual([])
  })
})
