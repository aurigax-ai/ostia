import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type DirMove,
  appConfigDir,
  appDataDir,
  moveOldDir,
  oldAppRunning,
  oldDirMoves,
  previewOldDir,
  projectDirMoves,
  savedWorkspaceFolders,
} from './userDirs'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-user-dirs-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function write(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, mode === undefined ? undefined : { mode })
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function move(from: string, to: string, extra: Partial<DirMove> = {}): DirMove {
  return { from, to, leave: [], drop: [], ...extra }
}

describe('app folders', () => {
  it('names only the ostia folders, honouring XDG_CONFIG_HOME and XDG_DATA_HOME', () => {
    expect(appConfigDir({}, home)).toBe(join(home, '.config', 'ostia'))
    expect(appDataDir({}, home)).toBe(join(home, '.local', 'share', 'ostia'))
    const env = { XDG_CONFIG_HOME: join(home, 'cfg'), XDG_DATA_HOME: join(home, 'data') }
    expect(appConfigDir(env, home)).toBe(join(home, 'cfg', 'ostia'))
    expect(appDataDir(env, home)).toBe(join(home, 'data', 'ostia'))
  })
})

describe('oldDirMoves', () => {
  it('finds nothing when no pine folder exists', () => {
    expect(oldDirMoves(join(home, '.config'), false, {}, home)).toEqual([])
  })

  it('finds the pine config and data folders and folds Chromium userData into config on Linux', () => {
    write(join(home, '.config/pine/settings.json'), '{}')
    write(join(home, '.local/share/pine/workspaces.json'), '{}')
    const moves = oldDirMoves(join(home, '.config'), false, {}, home)
    expect(moves.map((m) => [m.from, m.to])).toEqual([
      [join(home, '.config/pine'), join(home, '.config/ostia')],
      [join(home, '.local/share/pine'), join(home, '.local/share/ostia')],
    ])
    expect(moves[0]?.drop).toContain('GPUCache')
    expect(moves[1]?.leave).toEqual(['app'])
  })

  it('adds a separate userData folder where it is not the config folder, as on macOS', () => {
    const appData = join(home, 'Library/Application Support')
    write(join(appData, 'pine/Local Storage/x'), 'x')
    const moves = oldDirMoves(appData, false, {}, home)
    expect(moves.map((m) => [m.from, m.to])).toEqual([
      [join(appData, 'pine'), join(appData, 'ostia')],
    ])
  })

  it('skips a data folder that holds only the installed app, and userData under --user-data-dir', () => {
    mkdirSync(join(home, '.local/share/pine/app'), { recursive: true })
    write(join(home, '.config/pine/GPUCache/x'), 'x')
    expect(oldDirMoves(join(home, '.config'), false, {}, home)).toEqual([])
    rmSync(join(home, '.config/pine'), { recursive: true })
    write(join(home, 'Library/pine/Cookies'), 'c')
    expect(oldDirMoves(join(home, 'Library'), true, {}, home)).toEqual([])
  })
})

describe('oldAppRunning', () => {
  it('says the old app is running while its single-instance lock is there', () => {
    const from = join(home, '.config/pine')
    write(join(from, 'settings.json'), '{}')
    expect(oldAppRunning([move(from, join(home, '.config/ostia'))])).toBe(false)
    write(join(from, 'SingletonLock'), '')
    expect(oldAppRunning([move(from, join(home, '.config/ostia'))])).toBe(true)
  })
})

describe('moveOldDir', () => {
  it('moves every entry, keeps file modes and deletes the old folder', () => {
    const from = join(home, '.local/share/pine')
    const to = join(home, '.local/share/ostia')
    write(join(from, 'workspaces.json'), '{"w":1}')
    write(join(from, 'vault.json'), '{"K":"cipher"}', 0o600)
    write(join(from, 'scrollback/pane-1.txt'), 'history')

    const result = moveOldDir(move(from, to))

    expect(result).toEqual({ moved: ['scrollback', 'vault.json', 'workspaces.json'], replaced: [] })
    expect(read(join(to, 'workspaces.json'))).toBe('{"w":1}')
    expect(read(join(to, 'scrollback/pane-1.txt'))).toBe('history')
    expect(statSync(join(to, 'vault.json')).mode & 0o777).toBe(0o600)
    expect(existsSync(from)).toBe(false)
  })

  it('keeps what ostia already has and deletes the old copy of it', () => {
    const from = join(home, '.config/pine')
    const to = join(home, '.config/ostia')
    write(join(from, 'settings.json'), 'old')
    write(join(from, 'views/a.json'), '{}')
    write(join(to, 'settings.json'), 'new')

    expect(previewOldDir(move(from, to))).toEqual({ moved: ['views'], replaced: ['settings.json'] })
    expect(read(join(from, 'settings.json'))).toBe('old')

    expect(moveOldDir(move(from, to))).toEqual({ moved: ['views'], replaced: ['settings.json'] })
    expect(read(join(to, 'settings.json'))).toBe('new')
    expect(existsSync(join(to, 'views/a.json'))).toBe(true)
    expect(existsSync(from)).toBe(false)
  })

  it('drops Chromium caches, leaves the installed app and renames the shared browser profile', () => {
    const from = join(home, '.config/pine')
    const to = join(home, '.config/ostia')
    write(join(from, 'GPUCache/data'), 'cache')
    write(join(from, 'Partitions/pine-browser/Cookies'), 'logins')
    write(join(from, 'Partitions/other/Cookies'), 'other')
    write(join(to, 'Partitions/other/Cookies'), 'kept')
    mkdirSync(join(from, 'app'))

    const result = moveOldDir(move(from, to, { leave: ['app'], drop: ['GPUCache'] }))

    expect(result).toEqual({ moved: ['Partitions/pine-browser'], replaced: ['Partitions/other'] })
    expect(read(join(to, 'Partitions/ostia-browser/Cookies'))).toBe('logins')
    expect(read(join(to, 'Partitions/other/Cookies'))).toBe('kept')
    expect(existsSync(join(to, 'GPUCache'))).toBe(false)
    expect(readdirSync(from)).toEqual(['app'])
  })

  it('copies then deletes when the folders are on different filesystems', () => {
    const from = join(home, '.local/share/pine')
    const to = join(home, '.local/share/ostia')
    write(join(from, 'notes/a.md'), 'note')
    const crossDevice = (): void => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    }

    expect(moveOldDir(move(from, to), { rename: crossDevice }).moved).toEqual(['notes'])
    expect(read(join(to, 'notes/a.md'))).toBe('note')
    expect(existsSync(from)).toBe(false)
  })
})

describe('project folders', () => {
  it('reads the workspace folders saved by either version, expanding ~', () => {
    write(
      join(home, 'old.json'),
      JSON.stringify({ workspaces: [{ workDir: '~/code/a' }, { workDir: '~' }, { workDir: 3 }] }),
    )
    write(join(home, 'new.json'), JSON.stringify({ workspaces: [{ workDir: '~/code/a' }] }))
    expect(
      savedWorkspaceFolders(
        [join(home, 'old.json'), join(home, 'new.json'), join(home, 'none')],
        home,
      ),
    ).toEqual([join(home, 'code/a'), home])
  })

  it('offers to move a project .pine folder to .ostia only where one holds something', () => {
    write(join(home, 'a/.pine/vault.json'), '{}')
    mkdirSync(join(home, 'b/.pine'), { recursive: true })
    mkdirSync(join(home, 'c'), { recursive: true })
    expect(projectDirMoves([join(home, 'a'), join(home, 'b'), join(home, 'c')])).toEqual([
      { from: join(home, 'a/.pine'), to: join(home, 'a/.ostia'), leave: [], drop: [] },
    ])
  })
})
