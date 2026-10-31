import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { lock } from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  carryTrust,
  claudeConfigFile,
  folderTrust,
  outsideTrust,
  trustFolder,
} from './claudeFolderTrust'

let home: string
let config: string

function write(data: unknown, mode = 0o600): void {
  writeFileSync(config, `${JSON.stringify(data, null, 2)}\n`, { mode })
}

function read(): { projects?: Record<string, Record<string, unknown>> } & Record<string, unknown> {
  return JSON.parse(readFileSync(config, 'utf8'))
}

function folder(...parts: string[]): string {
  const dir = join(home, ...parts)
  mkdirSync(dir, { recursive: true })
  return dir
}

const place = (dir: string, workDir = dir) => ({ folder: dir, workDir, home })

beforeEach(() => {
  process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir())
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-claude-trust-')))
  config = join(home, '.claude.json')
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

describe('claudeConfigFile', () => {
  it('CFT-C1 follows Claude: the legacy file when it has content, else .claude.json in the config dir or home', async () => {
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude.json'))
    const dir = folder('profile')
    expect(await claudeConfigFile(home, dir)).toBe(join(dir, '.claude.json'))
    folder('.claude')
    writeFileSync(join(home, '.claude', '.config.json'), '')
    writeFileSync(join(home, '.claude.json'), '{}')
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude.json'))
    writeFileSync(join(home, '.claude', '.config.json'), '{}')
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude', '.config.json'))
  })

  it('CFT-C23 picks an empty writable legacy file only while .claude.json is missing, and the custom OAuth name', async () => {
    folder('.claude')
    writeFileSync(join(home, '.claude', '.config.json'), '')
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude', '.config.json'))
    writeFileSync(join(home, '.claude', '.config.json'), '', { mode: 0o444 })
    chmodSync(join(home, '.claude', '.config.json'), 0o444)
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude.json'))
    expect(await claudeConfigFile(home, undefined, true)).toBe(
      join(home, '.claude-custom-oauth.json'),
    )
  })
})

describe('folderTrust', () => {
  it('CFT-C64 ignores a stray .git above the test temp root', async () => {
    const stray = join(realpathSync(tmpdir()), '.git')
    mkdirSync(stray)
    try {
      write({})
      const plain = folder('notes')
      expect(await folderTrust(place(plain))).toEqual({ state: 'ask', folder: plain })
    } finally {
      rmSync(stray, { recursive: true, force: true })
    }
  })

  it('CFT-C2 reads the folder’s own entry or an ancestor’s up to the git root, as Claude does', async () => {
    const repo = folder('work', 'repo')
    mkdirSync(join(repo, '.git'))
    const sub = folder('work', 'repo', 'pkg')
    write({ projects: { [repo]: { hasTrustDialogAccepted: true } } })
    expect(await folderTrust(place(sub, repo))).toEqual({ state: 'trusted' })
    write({ projects: { [join(home, 'work')]: { hasTrustDialogAccepted: true } } })
    expect(await folderTrust(place(sub, repo))).toEqual({ state: 'ask', folder: repo })
  })

  it('CFT-C3 offers the repo root inside a repo and the folder itself outside one', async () => {
    write({})
    const plain = folder('notes')
    expect(await folderTrust(place(plain))).toEqual({ state: 'ask', folder: plain })
    const repo = folder('repo')
    mkdirSync(join(repo, '.git'))
    expect(await folderTrust(place(folder('repo', 'a', 'b'), repo))).toEqual({
      state: 'ask',
      folder: repo,
    })
  })

  it('CFT-C4 offers nothing for home, an ancestor of home, a root above the workspace or a missing folder', async () => {
    write({})
    expect(await folderTrust(place(home))).toEqual({ state: 'unknown' })
    expect(await folderTrust({ folder: '/', workDir: '/', home })).toEqual({ state: 'unknown' })
    const repo = folder('mono')
    mkdirSync(join(repo, '.git'))
    const pkg = folder('mono', 'pkg')
    expect(await folderTrust(place(pkg, pkg))).toEqual({ state: 'unknown' })
    expect(await folderTrust(place(join(home, 'gone')))).toEqual({ state: 'unknown' })
    const outside = folder('elsewhere')
    expect(await folderTrust(place(outside, folder('ws')))).toEqual({ state: 'unknown' })
  })

  it('CFT-C5 says unknown when Claude’s config is missing or not an object', async () => {
    const dir = folder('p')
    expect(await folderTrust(place(dir))).toEqual({ state: 'unknown' })
    writeFileSync(config, 'not json')
    expect(await folderTrust(place(dir))).toEqual({ state: 'unknown' })
    writeFileSync(config, '[]')
    expect(await folderTrust(place(dir))).toEqual({ state: 'unknown' })
  })
})

describe('folderTrust limits', () => {
  it('CFT-C24 treats a worktree as trusted when Claude trusted its main repository', async () => {
    const main = folder('src', 'main')
    mkdirSync(join(main, '.git', 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..\n')
    const tree = folder('src', 'wt')
    writeFileSync(join(tree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`)
    write({ projects: { [main]: { hasTrustDialogAccepted: true } } })
    expect(await folderTrust(place(tree))).toEqual({ state: 'trusted' })
    write({ projects: {} })
    expect(await folderTrust(place(tree))).toEqual({ state: 'ask', folder: tree })
  })

  it('CFT-C25 offers nothing when the workspace folder is /, home or above home', async () => {
    write({})
    const dir = folder('p')
    expect(await folderTrust({ folder: dir, workDir: '/', home })).toEqual({ state: 'unknown' })
    expect(await folderTrust({ folder: dir, workDir: home, home })).toEqual({ state: 'unknown' })
    expect(await folderTrust({ folder: dir, workDir: dirname(home), home })).toEqual({
      state: 'unknown',
    })
  })

  it('CFT-C26 never reads a config past the size cap', async () => {
    writeFileSync(config, `{"projects":{}}${' '.repeat(33 * 1024 * 1024)}`)
    expect(await folderTrust(place(folder('p')))).toEqual({ state: 'unknown' })
  })
})

describe('reads of agent-writable files', () => {
  it.skipIf(process.platform === 'win32')(
    'CFT-C33 never blocks on a FIFO a worktree pointer names, and treats it as no main repository',
    async () => {
      const gitDir = folder('elsewhere', 'gitdir')
      spawnSync('mkfifo', [join(gitDir, 'commondir')])
      const tree = folder('src', 'wt')
      writeFileSync(join(tree, '.git'), `gitdir: ${gitDir}\n`)
      write({ projects: {} })
      expect(await folderTrust(place(tree))).toEqual({ state: 'ask', folder: tree })
    },
    3_000,
  )
})

describe('trustFolder', () => {
  it('CFT-C6 sets only the one key, keeping every other key, the project’s fields and the file mode', async () => {
    const dir = folder('proj')
    write({ userID: 'u', projects: { [dir]: { allowedTools: ['x'], lastCost: 1 } } }, 0o600)
    expect(await trustFolder(place(dir))).toBe(true)
    expect(read()).toEqual({
      userID: 'u',
      projects: { [dir]: { allowedTools: ['x'], lastCost: 1, hasTrustDialogAccepted: true } },
    })
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(readFileSync(config, 'utf8').endsWith('}\n')).toBe(true)
  })

  it('CFT-C7 creates a missing project entry with only that field, and leaves a trusted one untouched', async () => {
    const dir = folder('fresh')
    write({ projects: {} })
    expect(await trustFolder(place(dir))).toBe(true)
    expect(read().projects?.[dir]).toEqual({ hasTrustDialogAccepted: true })
    const before = readFileSync(config, 'utf8')
    expect(await trustFolder(place(dir))).toBe(true)
    expect(readFileSync(config, 'utf8')).toBe(before)
  })

  it('CFT-C8 writes nothing for a refused folder and never creates Claude’s config', async () => {
    write({})
    const before = readFileSync(config, 'utf8')
    expect(await trustFolder(place(home))).toBe(false)
    expect(readFileSync(config, 'utf8')).toBe(before)
    rmSync(config)
    expect(await trustFolder(place(folder('x')))).toBe(false)
    expect(() => statSync(config)).toThrow()
  })
})

describe('trustFolder writes like Claude', () => {
  it('CFT-C27 writes through a symlinked config to its target and keeps the link', async () => {
    const dotfiles = folder('dotfiles')
    const target = join(dotfiles, 'claude.json')
    writeFileSync(target, '{"projects":{}}\n', { mode: 0o600 })
    symlinkSync(target, config)
    const dir = folder('proj')
    expect(await trustFolder(place(dir))).toBe(true)
    expect(lstatSync(config).isSymbolicLink()).toBe(true)
    expect(JSON.parse(readFileSync(target, 'utf8')).projects[dir]).toEqual({
      hasTrustDialogAccepted: true,
    })
  })

  it('CFT-C28 keeps the order of every key it does not touch', async () => {
    const dir = folder('proj')
    write({ zeta: 1, projects: { '/b': { z: 1, a: 2 }, [dir]: { y: 1, b: 2 } }, alpha: 2 })
    expect(await trustFolder(place(dir))).toBe(true)
    const back = read()
    expect(Object.keys(back)).toEqual(['zeta', 'projects', 'alpha'])
    expect(Object.keys(back.projects ?? {})).toEqual(['/b', dir])
    expect(Object.keys(back.projects?.[dir] ?? {})).toEqual(['y', 'b', 'hasTrustDialogAccepted'])
  })

  it('CFT-C29 takes the lock Claude takes, and writes nothing while Claude holds it', async () => {
    const dir = folder('proj')
    write({ projects: {} })
    const before = readFileSync(config, 'utf8')
    const release = await lock(config, { lockfilePath: `${config}.lock`, realpath: false })
    try {
      expect(await trustFolder(place(dir))).toBe(false)
      expect(readFileSync(config, 'utf8')).toBe(before)
    } finally {
      await release()
    }
    expect(await trustFolder(place(dir))).toBe(true)
    expect(() => statSync(`${config}.lock`)).toThrow()
  })
})

describe('carryTrust', () => {
  let profile: string
  let profileConfig: string

  const carry = (dir: string, workDir = dir) =>
    carryTrust({ ...place(dir, workDir), configDir: profile }, undefined)
  const writeProfile = (data: unknown) =>
    writeFileSync(profileConfig, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  const readProfile = () => JSON.parse(readFileSync(profileConfig, 'utf8'))

  beforeEach(() => {
    profile = folder('profile')
    profileConfig = join(profile, '.claude.json')
    writeProfile({ oauthAccount: { emailAddress: 'w@example.com' }, projects: {} })
  })

  it('CFT-C39 copies the trust of exactly the session folder when the Default config trusts it, keeping the rest', async () => {
    const dir = folder('shop')
    write({ projects: { [dir]: { hasTrustDialogAccepted: true, allowedTools: ['x'] } } })
    writeProfile({ oauthAccount: { emailAddress: 'w@example.com' }, projects: { '/p': { a: 1 } } })
    expect(await carry(dir)).toBe(true)
    expect(readProfile()).toEqual({
      oauthAccount: { emailAddress: 'w@example.com' },
      projects: { '/p': { a: 1 }, [dir]: { hasTrustDialogAccepted: true } },
    })
    expect(read().projects?.[dir]).toEqual({ hasTrustDialogAccepted: true, allowedTools: ['x'] })
  })

  it('CFT-C40 copies nothing the Default config does not have: no entry, an untrusted entry or only a parent', async () => {
    const dir = folder('work', 'shop')
    const before = readFileSync(profileConfig, 'utf8')
    for (const projects of [
      {},
      { [dir]: { hasTrustDialogAccepted: false } },
      { [dir]: { allowedTools: [] } },
      { [join(home, 'work')]: { hasTrustDialogAccepted: true } },
    ]) {
      write({ projects })
      await carry(dir)
      expect(readFileSync(profileConfig, 'utf8')).toBe(before)
    }
  })

  it('CFT-C41 uses the git root as the key and copies only when the Default config trusts that root', async () => {
    const repo = folder('repo')
    mkdirSync(join(repo, '.git'))
    const sub = folder('repo', 'pkg')
    write({ projects: { [sub]: { hasTrustDialogAccepted: true } } })
    const before = readFileSync(profileConfig, 'utf8')
    await carry(sub, repo)
    expect(readFileSync(profileConfig, 'utf8')).toBe(before)
    write({ projects: { [repo]: { hasTrustDialogAccepted: true } } })
    expect(await carry(sub, repo)).toBe(true)
    expect(Object.keys(readProfile().projects)).toEqual([repo])
  })

  it('CFT-C42 refuses /, home, above home, a folder above the workspace and a missing folder', async () => {
    const before = readFileSync(profileConfig, 'utf8')
    const dir = folder('mono')
    mkdirSync(join(dir, '.git'))
    const pkg = folder('mono', 'pkg')
    write({ projects: { [dir]: { hasTrustDialogAccepted: true } } })
    for (const refused of [
      carry(home),
      carryTrust({ folder: '/', workDir: '/', home, configDir: profile }, undefined),
      carryTrust({ folder: dir, workDir: dirname(home), home, configDir: profile }, undefined),
      carry(pkg, pkg),
      carry(join(home, 'gone')),
    ])
      expect(await refused).toBe(false)
    expect(readFileSync(profileConfig, 'utf8')).toBe(before)
  })

  it('CFT-C43 never creates the profile’s config', async () => {
    const dir = folder('shop')
    write({ projects: { [dir]: { hasTrustDialogAccepted: true } } })
    rmSync(profileConfig)
    expect(await carry(dir)).toBe(false)
    expect(() => statSync(profileConfig)).toThrow()
  })

  it('CFT-C44 writes nothing when the Default config is missing, not an object, not JSON or over the cap', async () => {
    const dir = folder('shop')
    const before = readFileSync(profileConfig, 'utf8')
    expect(await carry(dir)).toBe(false)
    for (const text of ['[]', 'not json', `{"projects":{}}${' '.repeat(33 * 1024 * 1024)}`]) {
      writeFileSync(config, text)
      expect(await carry(dir)).toBe(false)
    }
    expect(readFileSync(profileConfig, 'utf8')).toBe(before)
  })

  it('CFT-C45 never writes the Default config: without a profile folder it does nothing', async () => {
    const dir = folder('shop')
    write({ projects: { [dir]: { hasTrustDialogAccepted: true } } })
    const before = readFileSync(config, 'utf8')
    expect(await carryTrust(place(dir), undefined)).toBe(false)
    expect(readFileSync(config, 'utf8')).toBe(before)
  })

  it('CFT-C46 leaves a profile that already trusts the folder or a parent untouched', async () => {
    const repo = folder('repo')
    mkdirSync(join(repo, '.git'))
    write({ projects: { [repo]: { hasTrustDialogAccepted: true } } })
    writeProfile({ projects: { [repo]: { hasTrustDialogAccepted: true, extra: 1 } } })
    const before = readFileSync(profileConfig, 'utf8')
    expect(await carry(repo)).toBe(true)
    expect(readFileSync(profileConfig, 'utf8')).toBe(before)
  })

  it('CFT-C47 takes the lock Claude takes, and writes nothing while Claude holds it', async () => {
    const dir = folder('shop')
    write({ projects: { [dir]: { hasTrustDialogAccepted: true } } })
    const before = readFileSync(profileConfig, 'utf8')
    const release = await lock(profileConfig, {
      lockfilePath: `${profileConfig}.lock`,
      realpath: false,
    })
    try {
      expect(await carry(dir)).toBe(false)
      expect(readFileSync(profileConfig, 'utf8')).toBe(before)
    } finally {
      await release()
    }
    expect(await carry(dir)).toBe(true)
    expect(() => statSync(`${profileConfig}.lock`)).toThrow()
  })

  it('CFT-C48 reads the Default config from the given config folder', async () => {
    const dir = folder('shop')
    const elsewhere = folder('elsewhere')
    writeFileSync(
      join(elsewhere, '.claude.json'),
      JSON.stringify({ projects: { [dir]: { hasTrustDialogAccepted: true } } }),
    )
    write({ projects: {} })
    expect(await carryTrust({ ...place(dir), configDir: profile }, elsewhere)).toBe(true)
    expect(readProfile().projects[dir]).toEqual({ hasTrustDialogAccepted: true })
  })
})

describe('outsideTrust', () => {
  it('CFT-C62 names a folder outside the workspace folder that Claude has not accepted', async () => {
    write({ projects: {} })
    const work = folder('work')
    const other = folder('other')
    expect(await outsideTrust({ folder: other, workDir: work, home })).toBe(other)
  })

  it('CFT-C63 answers nothing when the folder or a parent is accepted, is inside the workspace, or the config is unreadable', async () => {
    const work = folder('work')
    const other = folder('other')
    const child = folder('other', 'child')
    expect(await outsideTrust({ folder: other, workDir: work, home })).toBeNull()
    write({ projects: { [other]: { hasTrustDialogAccepted: true } } })
    expect(await outsideTrust({ folder: child, workDir: work, home })).toBeNull()
    write({ projects: {} })
    expect(await outsideTrust({ folder: work, workDir: work, home })).toBeNull()
    expect(await outsideTrust({ folder: join(home, 'missing'), workDir: work, home })).toBeNull()
  })
})
