import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  folderRefusal,
  loadPhoneWorkspace,
  type PhoneWorkspacePaths,
  phoneFolderState,
  phoneWorkspaceDefaults,
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
      defaultFolder: join(root, 'data', 'ostia', 'remote-workspace'),
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

  it('PHW-C2 saves only a valid choice', () => {
    expect(loadPhoneWorkspace()).toEqual({ folder: null, agent: 'claude' })
    expect(setPhoneWorkspace({ folder: join(root, 'home'), agent: 'codex' }, paths)).toEqual({
      ok: false,
      error: 'home',
    })
    expect(setPhoneWorkspace({ folder: 'relative', agent: 'codex' }, paths)).toEqual({
      ok: false,
      error: 'invalid',
    })
    expect(setPhoneWorkspace({ folder: null, agent: 'bash' }, paths)).toEqual({
      ok: false,
      error: 'invalid',
    })
    const jobs = join(root, 'home', 'jobs')
    expect(setPhoneWorkspace({ folder: jobs, agent: 'codex' }, paths)).toEqual({
      ok: true,
      value: { folder: jobs, agent: 'codex' },
    })
    expect(loadPhoneWorkspace()).toEqual({ folder: jobs, agent: 'codex' })
    setPhoneWorkspace({ folder: null, agent: 'codex' }, paths)
    expect(loadPhoneWorkspace()).toEqual({ folder: null, agent: 'codex' })
  })

  it('PHW-C12 makes the default folder 0700 on first use and exempts only that exact folder', () => {
    const own = paths.defaultFolder
    mkdirSync(own, { mode: 0o700 })
    expect(folderRefusal(own, paths)).toBeNull()
    expect(folderRefusal(join(own, '..'), paths)).toBe('ostia-data')
    mkdirSync(join(own, 'sub'))
    expect(folderRefusal(join(own, 'sub'), paths)).toBe('ostia-data')
    mkdirSync(`${own}-x`)
    expect(folderRefusal(`${own}-x`, paths)).toBe('ostia-data')
    symlinkSync(join(root, 'data', 'ostia'), join(root, 'link'))
    expect(folderRefusal(join(root, 'link'), paths)).toBe('ostia-data')
    expect(setPhoneWorkspace({ folder: `${own}-x`, agent: 'claude' }, paths)).toEqual({
      ok: false,
      error: 'ostia-data',
    })
  })

  it('PHW-C13 refuses a default folder that is a symlink into Ostia data', () => {
    symlinkSync(join(root, 'data', 'ostia'), paths.defaultFolder)
    expect(folderRefusal(paths.defaultFolder, paths)).toBe('ostia-data')
  })

  it('PHW-C14 choosing the default folder stores no folder', () => {
    mkdirSync(paths.defaultFolder, { recursive: true })
    expect(setPhoneWorkspace({ folder: paths.defaultFolder, agent: 'claude' }, paths)).toEqual({
      ok: true,
      value: { folder: null, agent: 'claude' },
    })
  })

  it('PHW-C15 opens, then reuses, a workspace on the default folder when nothing is saved', async () => {
    const open = vi.fn(async () => 'default-ws')
    const workspaces = vi.fn(
      async () => [] as { workspaceId: string; kind: string; workDir: string }[],
    )
    const deps = { paths: () => paths, workspaces, open }
    expect(await phoneWorkspaceId(deps)).toBe('default-ws')
    expect(open).toHaveBeenCalledWith(paths.defaultFolder)
    expect(statSync(paths.defaultFolder).mode & 0o777).toBe(0o700)
    workspaces.mockResolvedValueOnce([
      { workspaceId: 'existing', kind: 'agent', workDir: paths.defaultFolder },
    ])
    open.mockClear()
    expect(await phoneWorkspaceId(deps)).toBe('existing')
    expect(open).not.toHaveBeenCalled()
    expect(phoneWorkspaceDefaults(paths)).toEqual({ set: true, agent: 'claude' })
  })

  it('PHW-C16 looking at the default folder never creates it', () => {
    expect(phoneFolderState(loadPhoneWorkspace(), paths)).toEqual({
      folder: paths.defaultFolder,
      problem: null,
      absent: true,
    })
    expect(phoneWorkspaceDefaults(paths)).toEqual({ set: true, agent: 'claude' })
    expect(() => statSync(paths.defaultFolder)).toThrow()
  })

  it('PHW-C17 opens nothing and offers no default when the default path cannot be a folder', async () => {
    const open = vi.fn(async () => 'ws')
    const deps = { paths: () => paths, workspaces: vi.fn(async () => []), open }
    const unusable = async () => {
      expect(await phoneWorkspaceId(deps)).toBeNull()
      expect(phoneWorkspaceDefaults(paths)).toEqual({ set: false, agent: 'claude' })
      expect(phoneFolderState(loadPhoneWorkspace(), paths).problem).toBe('missing')
    }
    writeFileSync(paths.defaultFolder, 'x')
    await unusable()
    rmSync(paths.defaultFolder)
    symlinkSync(join(root, 'gone'), paths.defaultFolder)
    await unusable()
    rmSync(paths.defaultFolder)
    symlinkSync(join(root, 'home', 'jobs'), paths.defaultFolder)
    await unusable()
    rmSync(paths.defaultFolder)
    chmodSync(join(root, 'data', 'ostia'), 0o500)
    try {
      await unusable()
    } finally {
      chmodSync(join(root, 'data', 'ostia'), 0o700)
    }
    expect(open).not.toHaveBeenCalled()
  })

  it('PHW-C18 tightens an existing default folder to 0700', async () => {
    mkdirSync(paths.defaultFolder, { mode: 0o755 })
    chmodSync(paths.defaultFolder, 0o755)
    const deps = {
      paths: () => paths,
      workspaces: vi.fn(async () => []),
      open: vi.fn(async () => 'ws'),
    }
    expect(await phoneWorkspaceId(deps)).toBe('ws')
    expect(statSync(paths.defaultFolder).mode & 0o777).toBe(0o700)
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
    setPhoneWorkspace({ folder: jobs, agent: 'claude' }, paths)
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

  it('PHW-C10 shares one open between concurrent calls and opens the folder it checked', async () => {
    const jobs = join(root, 'home', 'jobs')
    setPhoneWorkspace({ folder: jobs, agent: 'claude' }, paths)
    let finish: (id: string) => void = () => {}
    const open = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finish = resolve
        }),
    )
    const deps = { paths: () => paths, workspaces: vi.fn(async () => []), open }
    const first = phoneWorkspaceId(deps)
    const second = phoneWorkspaceId(deps)
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    finish('opened')
    expect(await Promise.all([first, second])).toEqual(['opened', 'opened'])
    rmSync(jobs, { recursive: true })
    symlinkSync(join(root, 'home', 'notes'), jobs)
    open.mockImplementationOnce(async () => 'notes-ws')
    expect(await phoneWorkspaceId(deps)).toBe('notes-ws')
    expect(open).toHaveBeenLastCalledWith(join(root, 'home', 'notes'))
  })

  it('PHW-C11 the phone hears set only while the folder is usable', () => {
    const jobs = join(root, 'home', 'jobs')
    setPhoneWorkspace({ folder: jobs, agent: 'codex' }, paths)
    expect(phoneWorkspaceDefaults(paths)).toEqual({ set: true, agent: 'codex' })
    rmSync(jobs, { recursive: true })
    expect(phoneWorkspaceDefaults(paths)).toEqual({ set: false, agent: 'codex' })
  })
})
