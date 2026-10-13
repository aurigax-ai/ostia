import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FAKE } from '../../../test/fixtures/secrets/samples'
import { scanSecrets } from '../privacy/secretScanner'
import { type DetectSecrets, ProfileSync, type SyncMethod } from './engine'
import { FolderMethod } from './folderMethod'
import type { SyncedExtension } from './profile'

const MARKET = 'https://github.com/aurigax-ai/ostia-extensions'
const TRELLIS: SyncedExtension = { id: 'trellis', marketplace: MARKET }
const noSecrets: DetectSecrets = async () => []

const roots: string[] = []
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'profile-sync-'))
  roots.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 6, 12, minute))

interface Machine {
  userData: string
  configDir: string
  sync: ProfileSync
  installed: SyncedExtension[]
  clock: { now: Date }
  useMethod: (method: SyncMethod | null) => void
  useTarget: (dir: string) => void
  writeSettings: (value: unknown, minute: number) => void
  settings: () => Record<string, unknown>
  writeFile: (rel: string, text: string, minute: number) => void
  file: (rel: string) => string | null
}

function machine(
  target: string,
  detectSecrets: DetectSecrets = noSecrets,
  install: (id: string, marketplace: string) => Promise<boolean> = async () => true,
): Machine {
  const root = temp()
  const userData = join(root, 'data')
  const configDir = join(root, 'config')
  mkdirSync(userData, { recursive: true })
  mkdirSync(configDir, { recursive: true })
  const installed: SyncedExtension[] = []
  const clock = { now: at(0) }
  let dir = target
  let custom: SyncMethod | null | undefined
  const sync = new ProfileSync({
    userData,
    configDir,
    now: () => clock.now,
    method: () => (custom !== undefined ? custom : new FolderMethod(dir, [userData, configDir])),
    targetLabel: () => dir,
    installedExtensions: () => installed,
    builtinIds: () => ['git'],
    installExtension: install,
    detectSecrets,
  })
  const stamp = (path: string, minute: number): void => {
    const time = at(minute)
    utimesSync(path, time, time)
  }
  return {
    userData,
    configDir,
    sync,
    installed,
    clock,
    useMethod: (method) => {
      custom = method
    },
    useTarget: (next) => {
      dir = next
      custom = undefined
    },
    writeSettings: (value, minute) => {
      const path = join(userData, 'settings.json')
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value))
      stamp(path, minute)
    },
    settings: () => JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8')),
    writeFile: (rel, text, minute) => {
      const path = join(configDir, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      stamp(path, minute)
    },
    file: (rel) => {
      const path = join(configDir, rel)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    },
  }
}

const targetJson = (target: string, rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(target, rel), 'utf8'))

const targetFile = (target: string, rel: string): string | null => {
  const path = join(target, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function racing(inner: SyncMethod, before: () => Promise<void>): SyncMethod {
  let raced = false
  return {
    id: inner.id,
    read: () => inner.read(),
    write: async (files, expected) => {
      if (!raced) {
        raced = true
        await before()
      }
      return inner.write(files, expected)
    },
  }
}

describe('FolderMethod', () => {
  it('PSY-C1 writes when the folder is still at the version that was read', async () => {
    const target = temp()
    const method = new FolderMethod(target, [])
    const first = await method.read()
    const files = new Map([['settings.json', '{"a":1}']])
    const res = await method.write(files, first.version)
    expect(res.ok).toBe(true)
    expect(targetFile(target, 'settings.json')).toBe('{"a":1}')
    const again = await method.read()
    expect(res.ok && res.version).toBe(again.version)
    expect(again.version).not.toBe(first.version)
  })
})

describe('ProfileSync', () => {
  it('PSY-C1 records the version it wrote', async () => {
    const target = temp()
    const a = machine(target)
    a.writeSettings({ appearance: { theme: 'dusk' } }, 1)
    const res = await a.sync.run()
    expect(res.status.state).toBe('ok')
    const state = JSON.parse(readFileSync(join(a.userData, 'sync-state.json'), 'utf8'))
    expect(state.version).toBe((await new FolderMethod(target, []).read()).version)
  })

  it('PSY-C2 re-reads and re-merges when another machine wrote in between', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.writeSettings({ appearance: { theme: 'dusk' } }, 1)
    await a.sync.run()
    await b.sync.run()
    b.writeSettings({ appearance: { theme: 'dusk' }, terminal: { fontSize: 15 } }, 2)
    a.writeSettings({ appearance: { theme: 'dawn' } }, 3)
    a.useMethod(
      racing(new FolderMethod(target, []), async () => {
        await b.sync.run()
      }),
    )
    const res = await a.sync.run()
    expect(res.status.state).toBe('ok')
    expect(targetJson(target, 'settings.json')).toEqual({
      appearance: { theme: 'dawn' },
      terminal: { fontSize: 15 },
    })
    expect(a.settings()).toEqual({ appearance: { theme: 'dawn' }, terminal: { fontSize: 15 } })
  })

  it('PSY-C3 changes nothing locally when the target fails mid-run, and finishes next time', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    b.writeSettings({ appearance: { theme: 'dusk' } }, 1)
    await b.sync.run()
    a.writeSettings({ terminal: { fontSize: 15 } }, 2)
    const folder = new FolderMethod(target, [])
    a.useMethod({
      id: folder.id,
      read: () => folder.read(),
      write: async () => {
        throw new Error('EIO')
      },
    })
    const failed = await a.sync.run()
    expect(failed.status.state).toBe('error')
    expect(failed.status.error).toBe('unreachable')
    expect(a.settings()).toEqual({ terminal: { fontSize: 15 } })
    a.useTarget(target)
    const ok = await a.sync.run()
    expect(ok.status.state).toBe('ok')
    expect(a.settings()).toEqual({ appearance: { theme: 'dusk' }, terminal: { fontSize: 15 } })
  })

  it('PSY-C4 carries settings, extensions, workflows, completion specs and views to another machine', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.writeSettings(
      { appearance: { theme: 'dusk' }, keybindings: { 'workspace.new': 'Ctrl+N' } },
      1,
    )
    a.installed.push(TRELLIS)
    a.writeFile('workflows/deploy.yaml', 'name: deploy\ncommand: make deploy\n', 1)
    a.writeFile('completions/mytool.json', '{"name":"mytool"}', 1)
    a.writeFile('views/board.json', '{"title":"Board"}', 1)
    await a.sync.run()
    const res = await b.sync.run()
    expect(b.settings()).toEqual({
      appearance: { theme: 'dusk' },
      keybindings: { 'workspace.new': 'Ctrl+N' },
    })
    expect(b.file('workflows/deploy.yaml')).toBe('name: deploy\ncommand: make deploy\n')
    expect(b.file('completions/mytool.json')).toBe('{"name":"mytool"}')
    expect(b.file('views/board.json')).toBe('{"title":"Board"}')
    expect(res.status.offers).toEqual([TRELLIS])
  })

  it('PSY-C5 leaves a project workflow out of the target', async () => {
    const target = temp()
    const a = machine(target)
    const project = join(dirname(a.configDir), 'project', '.ostia', 'workflows')
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'local.yaml'), 'name: local\ncommand: ls\n')
    a.writeFile('workflows/mine.yaml', 'name: mine\ncommand: ls\n', 1)
    await a.sync.run()
    expect(targetFile(target, 'workflows/mine.yaml')).not.toBeNull()
    expect(targetFile(target, 'workflows/local.yaml')).toBeNull()
  })

  it('PSY-C6 merges different settings changed on two machines without a conflict', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.writeSettings({ appearance: { theme: 'dusk' }, terminal: { fontSize: 13 } }, 1)
    await a.sync.run()
    await b.sync.run()
    a.writeSettings({ appearance: { theme: 'dawn' }, terminal: { fontSize: 13 } }, 2)
    b.writeSettings({ appearance: { theme: 'dusk' }, terminal: { fontSize: 15 } }, 3)
    await a.sync.run()
    const res = await b.sync.run()
    await a.sync.run()
    const both = { appearance: { theme: 'dawn' }, terminal: { fontSize: 15 } }
    expect(a.settings()).toEqual(both)
    expect(b.settings()).toEqual(both)
    expect(res.status.conflicts).toEqual([])
  })

  it('PSY-C7 merges as a first sync when the stored base is missing or broken', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.writeSettings({ appearance: { theme: 'dusk' } }, 1)
    await a.sync.run()
    await b.sync.run()
    b.writeSettings({ appearance: { theme: 'dusk' } }, 1)
    writeFileSync(join(b.userData, 'sync-base', 'base.json'), '{broken')
    a.writeSettings({ appearance: { theme: 'dawn' } }, 5)
    await a.sync.run()
    await b.sync.run()
    expect(b.settings()).toEqual({ appearance: { theme: 'dawn' } })
    expect(targetJson(target, 'settings.json')).toEqual({ appearance: { theme: 'dawn' } })
  })

  it('PSY-C8 neither pushes nor overwrites an invalid settings.json and names it', async () => {
    const target = temp()
    const a = machine(target)
    const b = machine(target)
    a.writeSettings({ appearance: { theme: 'dusk' } }, 1)
    await a.sync.run()
    b.writeSettings('{not json', 2)
    const res = await b.sync.run()
    expect(readFileSync(join(b.userData, 'settings.json'), 'utf8')).toBe('{not json')
    expect(targetJson(target, 'settings.json')).toEqual({ appearance: { theme: 'dusk' } })
    expect(res.status.state).toBe('error')
    expect(res.status.error).toBe('invalid-json:settings.json')
  })

  describe('conflicts', () => {
    async function clash(): Promise<{ target: string; a: Machine; b: Machine }> {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      a.writeSettings({ terminal: { fontSize: 13 } }, 1)
      await a.sync.run()
      await b.sync.run()
      a.writeSettings({ terminal: { fontSize: 14 } }, 2)
      b.writeSettings({ terminal: { fontSize: 16 } }, 4)
      a.clock.now = at(3)
      await a.sync.run()
      b.clock.now = at(5)
      await b.sync.run()
      return { target, a, b }
    }

    it('PSY-C9 keeps the most recent change and lists the key with both values', async () => {
      const { a, b } = await clash()
      await a.sync.run()
      expect(a.settings()).toEqual({ terminal: { fontSize: 16 } })
      expect(b.settings()).toEqual({ terminal: { fontSize: 16 } })
      expect(b.sync.status().conflicts).toEqual([
        {
          id: 'setting:["terminal","fontSize"]',
          kind: 'setting',
          key: 'terminal.fontSize',
          local: '16',
          remote: '14',
          winner: 'local',
        },
      ])
    })

    it('PSY-C10 applies and pushes the other value when the human picks it', async () => {
      const { a, b } = await clash()
      b.clock.now = at(6)
      const status = await b.sync.resolve('setting:["terminal","fontSize"]')
      expect(b.settings()).toEqual({ terminal: { fontSize: 14 } })
      expect(status.conflicts).toEqual([])
      await a.sync.run()
      expect(a.settings()).toEqual({ terminal: { fontSize: 14 } })
    })

    it('PSY-C11 drops a listed conflict once the key changes again', async () => {
      const { a, b } = await clash()
      await a.sync.run()
      a.writeSettings({ terminal: { fontSize: 18 } }, 10)
      a.clock.now = at(11)
      await a.sync.run()
      const res = await b.sync.run()
      expect(b.settings()).toEqual({ terminal: { fontSize: 18 } })
      expect(res.status.conflicts).toEqual([])
    })
  })

  describe('extensions', () => {
    it('PSY-C12 offers an extension another machine has and installs nothing', async () => {
      const target = temp()
      const install = vi.fn(async () => true)
      const a = machine(target)
      const b = machine(target, noSecrets, install)
      a.installed.push(TRELLIS)
      await a.sync.run()
      const res = await b.sync.run()
      expect(res.status.offers).toEqual([TRELLIS])
      expect(install).not.toHaveBeenCalled()
      expect(existsSync(join(b.userData, 'extensions.json'))).toBe(false)
    })

    it('PSY-C13 installs an offered extension from its marketplace on the human click', async () => {
      const target = temp()
      const install = vi.fn(async () => {
        b.installed.push(TRELLIS)
        return true
      })
      const a = machine(target)
      const b = machine(target, noSecrets, install)
      a.installed.push(TRELLIS)
      await a.sync.run()
      await b.sync.run()
      const status = await b.sync.install('trellis')
      expect(install).toHaveBeenCalledWith('trellis', MARKET)
      expect(status.offers).toEqual([])
      expect(await b.sync.install('keeper')).toMatchObject({ offers: [] })
      expect(install).toHaveBeenCalledTimes(1)
    })

    it('PSY-C14 does not offer an entry with a bad marketplace URL or a built-in id', async () => {
      const target = temp()
      const b = machine(target)
      writeFileSync(
        join(target, 'extensions.json'),
        JSON.stringify({
          extensions: [
            { id: 'evil', marketplace: 'file:///etc' },
            { id: 'git', marketplace: MARKET },
            { id: 'odd', marketplace: 'ext::sh -c id' },
            TRELLIS,
          ],
        }),
      )
      const res = await b.sync.run()
      expect(res.status.offers).toEqual([TRELLIS])
    })

    it('PSY-C15 leaves built-in extensions out of the synced list', async () => {
      const target = temp()
      const a = machine(target)
      a.installed.push({ id: 'git', marketplace: MARKET }, TRELLIS)
      await a.sync.run()
      expect(targetJson(target, 'extensions.json')).toEqual({ extensions: [TRELLIS] })
    })

    it('PSY-C23 never syncs approval or enabled state', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      const approvals = JSON.stringify({ trellis: { enabled: true, approved: ['shell'] } })
      writeFileSync(join(a.userData, 'extensions.json'), approvals)
      const pending = JSON.stringify({ trellis: { enabled: false, approved: null } })
      writeFileSync(join(b.userData, 'extensions.json'), pending)
      a.installed.push(TRELLIS)
      b.installed.push(TRELLIS)
      await a.sync.run()
      await b.sync.run()
      expect(readFileSync(join(b.userData, 'extensions.json'), 'utf8')).toBe(pending)
      expect(targetFile(target, 'extensions.json')).not.toContain('approved')
    })

    it('PSY-C24 ignores approval fields hand-written into the target', async () => {
      const target = temp()
      const b = machine(target)
      writeFileSync(
        join(target, 'extensions.json'),
        JSON.stringify({ extensions: [{ ...TRELLIS, approved: ['shell'], enabled: true }] }),
      )
      const res = await b.sync.run()
      expect(res.status.offers).toEqual([TRELLIS])
      expect(existsSync(join(b.userData, 'extensions.json'))).toBe(false)
    })
  })

  describe('profile folders', () => {
    it('PSY-C16 brings a view over without enabling it', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      a.writeFile('views/board.json', '{"title":"Board"}', 1)
      writeFileSync(join(a.userData, 'views.json'), JSON.stringify({ board: { enabled: true } }))
      await a.sync.run()
      await b.sync.run()
      expect(b.file('views/board.json')).toBe('{"title":"Board"}')
      expect(existsSync(join(b.userData, 'views.json'))).toBe(false)
      expect(targetFile(target, 'views.json')).toBeNull()
    })

    it('PSY-C27 ignores a views.json hand-placed in the target', async () => {
      const target = temp()
      const b = machine(target)
      writeFileSync(join(target, 'views.json'), JSON.stringify({ board: { enabled: true } }))
      mkdirSync(join(target, 'views'))
      writeFileSync(join(target, 'views', 'board.json'), '{"title":"Board"}')
      await b.sync.run()
      expect(b.file('views/board.json')).toBe('{"title":"Board"}')
      expect(existsSync(join(b.userData, 'views.json'))).toBe(false)
    })

    it('PSY-C17 deletes a file on the other machine after it was deleted on one', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      a.writeFile('completions/mytool.json', '{"name":"mytool"}', 1)
      await a.sync.run()
      await b.sync.run()
      expect(b.file('completions/mytool.json')).toBe('{"name":"mytool"}')
      rmSync(join(a.configDir, 'completions', 'mytool.json'))
      await a.sync.run()
      await b.sync.run()
      expect(b.file('completions/mytool.json')).toBeNull()
      expect(targetFile(target, 'completions/mytool.json')).toBeNull()
    })

    it('PSY-C18 copies no symlink or oversized file and names them', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      const outside = join(temp(), 'secret.json')
      writeFileSync(outside, '{"title":"x"}')
      mkdirSync(join(a.configDir, 'views'), { recursive: true })
      symlinkSync(outside, join(a.configDir, 'views', 'linked.json'))
      a.writeFile('views/huge.json', `{"t":"${'x'.repeat(70 * 1024)}"}`, 1)
      a.writeFile('views/ok.json', '{"title":"ok"}', 1)
      const res = await a.sync.run()
      expect(targetFile(target, 'views/linked.json')).toBeNull()
      expect(targetFile(target, 'views/huge.json')).toBeNull()
      expect(targetFile(target, 'views/ok.json')).toBe('{"title":"ok"}')
      expect(res.status.skipped).toEqual(['views/huge.json', 'views/linked.json'])
      symlinkSync(outside, join(target, 'views', 'other.json'))
      const pulled = await b.sync.run()
      expect(b.file('views/other.json')).toBeNull()
      expect(pulled.status.skipped).toEqual(['views/other.json'])
    })

    it('PSY-C19 keeps a workflow edited on one machine and deleted on the other, as a conflict', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      a.writeFile('workflows/deploy.yaml', 'name: deploy\ncommand: make\n', 1)
      await a.sync.run()
      await b.sync.run()
      rmSync(join(a.configDir, 'workflows', 'deploy.yaml'))
      a.clock.now = at(9)
      await a.sync.run()
      b.writeFile('workflows/deploy.yaml', 'name: deploy\ncommand: make all\n', 3)
      const res = await b.sync.run()
      expect(b.file('workflows/deploy.yaml')).toBe('name: deploy\ncommand: make all\n')
      expect(targetFile(target, 'workflows/deploy.yaml')).toBe('name: deploy\ncommand: make all\n')
      expect(res.status.conflicts).toMatchObject([
        { id: 'file:workflows/deploy.yaml', kind: 'file', winner: 'local', remote: null },
      ])
    })
  })

  describe('first sync', () => {
    it('PSY-C21 keeps keys from both sides and lists the ones that differ', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      a.writeSettings({ appearance: { theme: 'dusk' }, terminal: { fontSize: 13 } }, 1)
      await a.sync.run()
      b.writeSettings({ sidebar: { width: 300 }, terminal: { fontSize: 15 } }, 2)
      b.clock.now = at(3)
      const res = await b.sync.run()
      const merged = {
        appearance: { theme: 'dusk' },
        sidebar: { width: 300 },
        terminal: { fontSize: 15 },
      }
      expect(b.settings()).toEqual(merged)
      expect(targetJson(target, 'settings.json')).toEqual(merged)
      expect(res.status.conflicts.map((c) => c.key)).toEqual(['terminal.fontSize'])
    })

    it('PSY-C22 wipes neither profile when the folder is switched to one holding another', async () => {
      const first = temp()
      const second = temp()
      const a = machine(first)
      const c = machine(second)
      a.writeSettings({ appearance: { theme: 'dusk' } }, 1)
      a.writeFile('workflows/a.yaml', 'name: a\ncommand: ls\n', 1)
      await a.sync.run()
      c.writeSettings({ sidebar: { width: 300 } }, 1)
      c.writeFile('workflows/c.yaml', 'name: c\ncommand: ls\n', 1)
      await c.sync.run()
      a.useTarget(second)
      await a.sync.run()
      expect(a.settings()).toEqual({ appearance: { theme: 'dusk' }, sidebar: { width: 300 } })
      expect(a.file('workflows/c.yaml')).not.toBeNull()
      expect(targetFile(second, 'workflows/a.yaml')).not.toBeNull()
      expect(targetFile(second, 'workflows/c.yaml')).not.toBeNull()
    })
  })

  describe('machine-only settings', () => {
    it('PSY-C25 keeps terminal.shell on its machine', async () => {
      const target = temp()
      const a = machine(target)
      const b = machine(target)
      a.writeSettings({ terminal: { shell: '/opt/homebrew/bin/fish', fontSize: 14 } }, 1)
      b.writeSettings({ terminal: { shell: '/usr/bin/zsh' } }, 1)
      await a.sync.run()
      await b.sync.run()
      expect(targetJson(target, 'settings.json')).toEqual({ terminal: { fontSize: 14 } })
      expect(b.settings()).toEqual({ terminal: { shell: '/usr/bin/zsh', fontSize: 14 } })
    })

    it('PSY-C26 ignores a program setting hand-written into the target', async () => {
      const target = temp()
      const b = machine(target)
      writeFileSync(
        join(target, 'settings.json'),
        JSON.stringify({ notifications: { command: ['sh', '-c', 'id'], sound: true } }),
      )
      await b.sync.run()
      expect(b.settings()).toEqual({ notifications: { sound: true } })
    })
  })

  describe('secret check before a push', () => {
    it('PSY-C30 holds back a setting whose value holds a secret and pushes the rest', async () => {
      const target = temp()
      const a = machine(target, (text) => scanSecrets(text))
      a.writeSettings(
        {
          appearance: { theme: 'dusk' },
          browser: { homepage: `https://example.com/?token=${FAKE.githubClassic}` },
        },
        1,
      )
      const res = await a.sync.run()
      expect(targetFile(target, 'settings.json')).not.toContain(FAKE.githubClassic)
      expect(targetJson(target, 'settings.json')).toEqual({ appearance: { theme: 'dusk' } })
      expect(res.status.heldBack).toEqual(['browser.homepage'])
      expect(a.settings()).toMatchObject({ browser: { homepage: expect.any(String) } })
    })

    it('PSY-C31 pushes nothing when the scan fails', async () => {
      const target = temp()
      const a = machine(target, async () => {
        throw new Error('deadline')
      })
      a.writeSettings({ appearance: { theme: 'dusk' } }, 1)
      const res = await a.sync.run()
      expect(targetFile(target, 'settings.json')).toBeNull()
      expect(res.status.state).toBe('error')
      expect(res.status.error).toBe('scan-failed')
    })
  })
})
