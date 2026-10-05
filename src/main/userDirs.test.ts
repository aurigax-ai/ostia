import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_NOTICE,
  MIGRATED_MARKER,
  STAGING_DIR,
  appConfigDir,
  appDataDir,
  migrateDir,
  migrateUserDirs,
  resetUserDirs,
  userDirsPlan,
} from './userDirs'

let home: string
let env: Record<string, string | undefined>

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'ostia-user-dirs-')))
  env = {}
  resetUserDirs()
})

afterEach(() => {
  resetUserDirs()
})

function write(path: string, text: string, mode?: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text, mode === undefined ? undefined : { mode })
}

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function legacyTree(root: string): void {
  write(join(root, 'workspaces.json'), '{"w":1}')
  write(join(root, 'vault.json'), '{"K":"cipher"}', 0o600)
  write(join(root, 'scrollback', 'pane-1.txt'), 'history')
  write(join(root, 'notes', 'a.md'), 'note')
}

describe('migrateDir', () => {
  it('copies everything when only the old folder exists and leaves the old one untouched', () => {
    const from = join(home, '.local/share/pine')
    const to = join(home, '.local/share/ostia')
    legacyTree(from)
    const before = readdirSync(from).sort()

    const result = migrateDir({ from, to })

    expect(result.status).toBe('copied')
    expect(result.copied).toEqual(['notes', 'scrollback', 'vault.json', 'workspaces.json'])
    expect(read(join(to, 'workspaces.json'))).toBe('{"w":1}')
    expect(read(join(to, 'scrollback', 'pane-1.txt'))).toBe('history')
    expect(read(join(to, 'notes', 'a.md'))).toBe('note')
    expect(statSync(join(to, 'vault.json')).mode & 0o777).toBe(0o600)
    expect(read(join(from, 'workspaces.json'))).toBe('{"w":1}')
    expect(readdirSync(from).sort()).toEqual([...before, LEGACY_NOTICE].sort())
    expect(read(join(from, LEGACY_NOTICE))).toContain(to)
    expect(JSON.parse(read(join(to, MIGRATED_MARKER)))).toMatchObject({ from, kept: [] })
    expect(existsSync(join(to, STAGING_DIR))).toBe(false)
  })

  it('does nothing when only the new folder exists', () => {
    const from = join(home, '.config/pine')
    const to = join(home, '.config/ostia')
    write(join(to, 'settings.json'), '{"new":true}')

    expect(migrateDir({ from, to }).status).toBe('nothing')
    expect(existsSync(from)).toBe(false)
    expect(readdirSync(to)).toEqual(['settings.json'])
  })

  it('never overwrites what the new folder already has when both exist', () => {
    const from = join(home, '.config/pine')
    const to = join(home, '.config/ostia')
    write(join(from, 'settings.json'), '{"old":true}')
    write(join(from, 'views', 'a.json'), '{}')
    write(join(to, 'settings.json'), '{"new":true}')

    const result = migrateDir({ from, to })

    expect(result.status).toBe('copied')
    expect(result.copied).toEqual(['views'])
    expect(result.kept).toEqual(['settings.json'])
    expect(read(join(to, 'settings.json'))).toBe('{"new":true}')
    expect(read(join(from, 'settings.json'))).toBe('{"old":true}')
    expect(read(join(to, 'views', 'a.json'))).toBe('{}')
  })

  it('runs once: a second launch copies nothing even if the old folder changed', () => {
    const from = join(home, '.config/pine')
    const to = join(home, '.config/ostia')
    write(join(from, 'settings.json'), '{"v":1}')
    expect(migrateDir({ from, to }).status).toBe('copied')
    write(join(from, 'later.json'), '{}')
    write(join(to, 'settings.json'), '{"v":2}')

    expect(migrateDir({ from, to }).status).toBe('already')
    expect(existsSync(join(to, 'later.json'))).toBe(false)
    expect(read(join(to, 'settings.json'))).toBe('{"v":2}')
  })

  it('rolls back a copy that fails halfway and keeps the old folder intact', () => {
    const from = join(home, '.local/share/pine')
    const to = join(home, '.local/share/ostia')
    legacyTree(from)
    let calls = 0
    const result = migrateDir(
      { from, to },
      {
        copy: (src, dest) => {
          calls += 1
          if (calls === 3) {
            mkdirSync(dest, { recursive: true })
            writeFileSync(join(dest, 'partial'), 'x')
            throw new Error('ENOSPC: no space left on device')
          }
          cpSync(src, dest, { recursive: true })
        },
      },
    )

    expect(result.status).toBe('failed')
    expect(result.error).toContain('ENOSPC')
    expect(existsSync(to)).toBe(false)
    expect(existsSync(join(from, LEGACY_NOTICE))).toBe(false)
    expect(read(join(from, 'workspaces.json'))).toBe('{"w":1}')
    expect(read(join(from, 'scrollback', 'pane-1.txt'))).toBe('history')

    const retry = migrateDir({ from, to })
    expect(retry.status).toBe('copied')
    expect(retry.copied).toEqual(['notes', 'scrollback', 'vault.json', 'workspaces.json'])
  })

  it('keeps a new folder that existed before a failed copy, and only removes what it copied', () => {
    const from = join(home, '.local/share/pine')
    const to = join(home, '.local/share/ostia')
    legacyTree(from)
    write(join(to, 'app', 'ostia'), 'binary')
    const result = migrateDir(
      { from, to, skip: ['app'] },
      {
        copy: (src, dest) => {
          if (src.endsWith('vault.json')) throw new Error('EACCES: permission denied')
          cpSync(src, dest, { recursive: true })
        },
      },
    )

    expect(result.status).toBe('failed')
    expect(readdirSync(to)).toEqual(['app'])
  })

  it('finishes a copy an earlier launch left behind when it was killed', () => {
    const from = join(home, '.local/share/pine')
    const to = join(home, '.local/share/ostia')
    legacyTree(from)
    cpSync(join(from, 'notes'), join(to, 'notes'), { recursive: true })
    write(join(to, STAGING_DIR, 'scrollback', 'pane-1.txt'), 'half')

    const result = migrateDir({ from, to })

    expect(result.status).toBe('copied')
    expect(result.kept).toEqual(['notes'])
    expect(read(join(to, 'scrollback', 'pane-1.txt'))).toBe('history')
    expect(existsSync(join(to, STAGING_DIR))).toBe(false)
  })

  it('skips the given entries, sockets and Chromium locks, and keeps symlinks as links', async () => {
    const from = join(home, 'appData/pine')
    const to = join(home, 'appData/ostia')
    write(join(from, 'settings.json'), '{}')
    write(join(from, 'Cache', 'data_0'), 'cache')
    symlinkSync('host-123', join(from, 'SingletonLock'))
    symlinkSync('settings.json', join(from, 'link.json'))
    const socket = join(from, 's.sock')
    const server = createServer()
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    try {
      const result = migrateDir({ from, to, skip: ['Cache', 'SingletonLock'] })
      expect(result.copied).toEqual(['link.json', 'settings.json'])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(lstatSync(join(to, 'link.json')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(to, 'link.json'))).toBe('settings.json')
    expect(existsSync(join(to, 'Cache'))).toBe(false)
  })

  it('does nothing when the old path is not a folder', () => {
    const from = join(home, '.config/pine')
    write(from, 'not a folder')
    expect(migrateDir({ from, to: join(home, '.config/ostia') }).status).toBe('nothing')
  })
})

describe('migrateUserDirs', () => {
  it('moves the config, data and userData folders on macOS-style paths', () => {
    const appData = join(home, 'Library/Application Support')
    write(join(home, '.config/pine/extensions/hello/pine.json'), '{}')
    write(join(home, '.local/share/pine/workspaces.json'), '{"w":1}')
    write(join(home, '.local/share/pine/app/pine'), 'binary')
    write(join(appData, 'pine/settings.json'), '{"theme":"dark"}')
    write(join(appData, 'pine/logs/main.log'), 'log')
    write(join(appData, 'pine/GPUCache/index'), 'gpu')

    const plan = userDirsPlan(appData, false, env, home)
    const outcome = migrateUserDirs(plan)

    expect(outcome.config.status).toBe('copied')
    expect(outcome.data.status).toBe('copied')
    expect(outcome.userData?.status).toBe('copied')
    expect(existsSync(join(home, '.config/ostia/extensions/hello/pine.json'))).toBe(true)
    expect(read(join(home, '.local/share/ostia/workspaces.json'))).toBe('{"w":1}')
    expect(existsSync(join(home, '.local/share/ostia/app'))).toBe(false)
    expect(read(join(appData, 'ostia/settings.json'))).toBe('{"theme":"dark"}')
    expect(read(join(appData, 'ostia/logs/main.log'))).toBe('log')
    expect(existsSync(join(appData, 'ostia/GPUCache'))).toBe(false)
    expect(appConfigDir(env, home)).toBe(join(home, '.config/ostia'))
    expect(appDataDir(env, home)).toBe(join(home, '.local/share/ostia'))
  })

  it('treats a Linux userData that is the config folder as one move', () => {
    env = { XDG_CONFIG_HOME: join(home, 'xdg-config'), XDG_DATA_HOME: join(home, 'xdg-data') }
    const appData = join(home, 'xdg-config')
    write(join(appData, 'pine/settings.json'), '{}')
    write(join(appData, 'pine/extensions/hello/pine.json'), '{}')
    write(join(appData, 'pine/Code Cache/js'), 'cache')

    const plan = userDirsPlan(appData, false, env, home)
    const outcome = migrateUserDirs(plan)

    expect(outcome.userData).toBe(outcome.config)
    expect(outcome.config.copied).toEqual(['extensions', 'settings.json'])
    expect(existsSync(join(appData, 'ostia/Code Cache'))).toBe(false)
    expect(appConfigDir(env, home)).toBe(join(home, 'xdg-config/ostia'))
  })

  it('leaves userData alone when --user-data-dir chose it', () => {
    const appData = join(home, 'Library/Application Support')
    write(join(appData, 'pine/settings.json'), '{}')
    const plan = userDirsPlan(appData, true, env, home)
    expect(plan.userData).toBeUndefined()
    const outcome = migrateUserDirs(plan)
    expect(outcome.userData).toBeUndefined()
    expect(existsSync(join(appData, 'ostia'))).toBe(false)
  })

  it('keeps using the old folders when a copy fails, and tries again next launch', () => {
    write(join(home, '.config/pine/views/a.json'), '{}')
    write(join(home, '.local/share/pine/workspaces.json'), '{}')
    const plan = userDirsPlan(join(home, 'appData'), true, env, home)

    const outcome = migrateUserDirs(plan, {
      copy: () => {
        throw new Error('EIO: i/o error')
      },
    })

    expect(outcome.config.status).toBe('failed')
    expect(outcome.data.status).toBe('failed')
    expect(appConfigDir(env, home)).toBe(join(home, '.config/pine'))
    expect(appDataDir(env, home)).toBe(join(home, '.local/share/pine'))

    resetUserDirs()
    const next = migrateUserDirs(plan)
    expect(next.config.status).toBe('copied')
    expect(appConfigDir(env, home)).toBe(join(home, '.config/ostia'))
  })

  it('creates nothing for a new user', () => {
    const appData = join(home, 'Library/Application Support')
    const outcome = migrateUserDirs(userDirsPlan(appData, false, env, home))
    expect(outcome.config.status).toBe('nothing')
    expect(outcome.data.status).toBe('nothing')
    expect(outcome.userData?.status).toBe('nothing')
    expect(existsSync(join(home, '.config'))).toBe(false)
    expect(existsSync(join(home, '.local'))).toBe(false)
  })
})
