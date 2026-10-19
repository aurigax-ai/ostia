import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type PhoneWorkspacePaths,
  folderRefusal,
  loadPhoneWorkspace,
  phoneWorkspaceId,
  setPhoneWorkspace,
} from './phoneWorkspace'

describe('the Phone workspace', () => {
  let root: string
  let paths: PhoneWorkspacePaths
  let prevData: string | undefined

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-phone-ws-')))
    prevData = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(root, 'data')
    for (const dir of ['home/jobs', 'home/notes', 'data/ostia', 'scratch/one', 'artifacts']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    writeFileSync(join(root, 'home', 'file.txt'), 'x')
    paths = {
      home: join(root, 'home'),
      dataDirs: [join(root, 'data', 'ostia')],
      closedRoots: [join(root, 'scratch'), join(root, 'artifacts')],
    }
  })

  afterEach(() => {
    if (prevData === undefined) Reflect.deleteProperty(process.env, 'XDG_DATA_HOME')
    else process.env.XDG_DATA_HOME = prevData
    rmSync(root, { recursive: true, force: true })
  })

  it('PHW-C1 refuses a missing folder, a file, home, above home, Ostia data, scratch and artifacts', () => {
    expect(folderRefusal(join(root, 'home', 'jobs'), paths)).toBeNull()
    expect(folderRefusal(join(root, 'gone'), paths)).toBe('missing')
    expect(folderRefusal(join(root, 'home', 'file.txt'), paths)).toBe('missing')
    expect(folderRefusal(join(root, 'home'), paths)).toBe('home')
    expect(folderRefusal(root, paths)).toBe('above-home')
    expect(folderRefusal(join(root, 'data', 'ostia'), paths)).toBe('ostia-data')
    expect(folderRefusal(join(root, 'scratch', 'one'), paths)).toBe('scratch-or-artifacts')
    expect(folderRefusal(join(root, 'artifacts'), paths)).toBe('scratch-or-artifacts')
  })

  it('PHW-C2 saves only a valid choice, and clearing the folder turns the switch off', () => {
    expect(loadPhoneWorkspace()).toEqual({ folder: null, openNew: false, agent: 'claude' })
    expect(
      setPhoneWorkspace({ folder: join(root, 'home'), openNew: true, agent: 'codex' }, paths),
    ).toEqual({ ok: false, error: 'home' })
    expect(setPhoneWorkspace({ folder: 'relative', openNew: true, agent: 'codex' }, paths)).toEqual(
      {
        ok: false,
        error: 'invalid',
      },
    )
    expect(setPhoneWorkspace({ folder: null, openNew: true, agent: 'bash' }, paths)).toEqual({
      ok: false,
      error: 'invalid',
    })
    const jobs = join(root, 'home', 'jobs')
    expect(setPhoneWorkspace({ folder: jobs, openNew: true, agent: 'codex' }, paths)).toEqual({
      ok: true,
      value: { folder: jobs, openNew: true, agent: 'codex' },
    })
    expect(loadPhoneWorkspace()).toEqual({ folder: jobs, openNew: true, agent: 'codex' })
    setPhoneWorkspace({ folder: null, openNew: true, agent: 'codex' }, paths)
    expect(loadPhoneWorkspace()).toEqual({ folder: null, openNew: false, agent: 'codex' })
  })

  it('PHW-C3 reuses an open workspace on the folder, opens one otherwise, and never falls back', async () => {
    const jobs = join(root, 'home', 'jobs')
    const open = vi.fn(async () => 'opened')
    const deps = {
      paths: () => paths,
      workspaces: vi.fn(async () => [
        { workspaceId: 'scratchy', kind: 'scratch', workDir: jobs },
        { workspaceId: 'other', kind: 'agent', workDir: join(root, 'home', 'notes') },
      ]),
      open,
    }
    expect(await phoneWorkspaceId(deps)).toBeNull()
    setPhoneWorkspace({ folder: jobs, openNew: false, agent: 'claude' }, paths)
    expect(await phoneWorkspaceId(deps)).toBeNull()
    setPhoneWorkspace({ folder: jobs, openNew: true, agent: 'claude' }, paths)
    expect(await phoneWorkspaceId(deps)).toBe('opened')
    expect(open).toHaveBeenCalledWith(jobs)
    deps.workspaces.mockResolvedValueOnce([
      { workspaceId: 'jobs-ws', kind: 'agent', workDir: jobs },
    ])
    expect(await phoneWorkspaceId(deps)).toBe('jobs-ws')
    rmSync(jobs, { recursive: true })
    open.mockClear()
    expect(await phoneWorkspaceId(deps)).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
