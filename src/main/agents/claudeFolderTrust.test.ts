import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeConfigFile, folderTrust, trustFolder } from './claudeFolderTrust'

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
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude.json'))
    writeFileSync(join(home, '.claude', '.config.json'), '{}')
    expect(await claudeConfigFile(home)).toBe(join(home, '.claude', '.config.json'))
  })
})

describe('folderTrust', () => {
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
