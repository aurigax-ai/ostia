import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverExtensions, isInsideDir, parseManifest } from './extensionManifest'

const DIR = '/ext/demo'

function manifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'demo', name: 'Demo', version: '1.0.0', main: 'main.js', ...extra }
}

describe('parseManifest', () => {
  it('accepts a full manifest and fills contribution defaults', () => {
    const res = parseManifest(
      manifest({
        description: 'd',
        capabilities: ['notify', 'read-board'],
        contributes: {
          commands: [
            { id: 'open', title: 'Open Demo', category: 'App', capabilities: ['read-board'] },
            { id: 'set', title: 'Set', palette: false, stdin: true, usage: 'set <k>' },
          ],
          sidebarItems: true,
          panel: { title: 'Demo', icon: 'puzzle', entry: 'ui/panel.html' },
        },
      }),
      DIR,
    )
    expect(res).toEqual({
      ok: true,
      manifest: {
        id: 'demo',
        name: 'Demo',
        version: '1.0.0',
        description: 'd',
        capabilities: ['notify', 'read-board'],
        main: 'main.js',
        contributes: {
          commands: [
            {
              id: 'open',
              title: 'Open Demo',
              category: 'App',
              palette: true,
              stdin: false,
              capabilities: ['read-board'],
            },
            {
              id: 'set',
              title: 'Set',
              usage: 'set <k>',
              palette: false,
              stdin: true,
              capabilities: [],
            },
          ],
          sidebarItems: true,
          panel: { title: 'Demo', icon: 'puzzle', entry: 'ui/panel.html' },
        },
      },
    })
  })

  it('marks a command interactive only when the manifest says exactly true', () => {
    const res = parseManifest(
      manifest({
        contributes: {
          commands: [
            { id: 'ask', title: 'Ask', interactive: true },
            { id: 'quick', title: 'Quick', interactive: 'yes' },
          ],
        },
      }),
      DIR,
    )
    if (!res.ok) throw new Error(res.error)
    const [ask, quick] = res.manifest.contributes.commands
    expect(ask.interactive).toBe(true)
    expect(quick).not.toHaveProperty('interactive')
  })

  it('rejects ids that are not lowercase slugs', () => {
    for (const id of ['Demo', '../x', 'a', '__proto__', 'x'.repeat(41), 7]) {
      expect(parseManifest(manifest({ id }), DIR).ok).toBe(false)
    }
  })

  it('rejects unknown capabilities, both top-level and per command', () => {
    expect(parseManifest(manifest({ capabilities: ['root'] }), DIR)).toEqual({
      ok: false,
      error: "manifest: unknown capability 'root'",
    })
    const res = parseManifest(
      manifest({ contributes: { commands: [{ id: 'x', title: 'X', capabilities: ['nope'] }] } }),
      DIR,
    )
    expect(res.ok).toBe(false)
  })

  it('rejects a main or panel entry that escapes the extension directory', () => {
    expect(parseManifest(manifest({ main: '../evil.js' }), DIR).ok).toBe(false)
    expect(parseManifest(manifest({ main: '/usr/bin/evil' }), DIR).ok).toBe(false)
    const panel = (entry: string) =>
      parseManifest(manifest({ contributes: { panel: { title: 'P', entry } } }), DIR).ok
    expect(panel('../other/panel.html')).toBe(false)
    expect(panel('panel.js')).toBe(false)
    expect(panel('url')).toBe(true)
    expect(panel('panel.html')).toBe(true)
  })

  it('rejects duplicate command ids and commands without a process', () => {
    const dup = {
      commands: [
        { id: 'a', title: 'A' },
        { id: 'a', title: 'B' },
      ],
    }
    expect(parseManifest(manifest({ contributes: dup }), DIR)).toEqual({
      ok: false,
      error: "duplicate command 'a'",
    })
    const noMain = { id: 'demo', name: 'Demo', version: '1', contributes: { sidebarItems: true } }
    expect(parseManifest(noMain, DIR).ok).toBe(false)
  })

  it('allows a process-less extension that only ships a file panel', () => {
    const res = parseManifest(
      {
        id: 'static',
        name: 'S',
        version: '1',
        contributes: { panel: { title: 'S', entry: 'p.html' } },
      },
      DIR,
    )
    expect(res.ok).toBe(true)
  })

  it('drops an unknown panel icon instead of failing', () => {
    const res = parseManifest(
      manifest({ contributes: { panel: { title: 'P', icon: 'skull', entry: 'url' } } }),
      DIR,
    )
    expect(res.ok && res.manifest.contributes.panel).toEqual({ title: 'P', entry: 'url' })
  })
})

describe('isInsideDir', () => {
  it('is true only for paths strictly below the directory', () => {
    expect(isInsideDir('/a/b', 'c.html')).toBe(true)
    expect(isInsideDir('/a/b', '/a/b/c/d.html')).toBe(true)
    expect(isInsideDir('/a/b', '/a/b')).toBe(false)
    expect(isInsideDir('/a/b', '/a/bc/d.html')).toBe(false)
    expect(isInsideDir('/a/b', '../b2/x')).toBe(false)
  })
})

describe('discoverExtensions', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  })

  function root(exts: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), 'pine-ext-root-'))
    roots.push(dir)
    for (const [name, content] of Object.entries(exts)) {
      mkdirSync(join(dir, name))
      writeFileSync(
        join(dir, name, 'pine.json'),
        typeof content === 'string' ? content : JSON.stringify(content),
      )
    }
    return dir
  }

  it('finds valid extensions and reports broken ones without failing the rest', () => {
    const dir = root({
      good: manifest({ id: 'good' }),
      broken: '{ not json',
      invalid: { id: 'Bad Id', name: 'x', version: '1' },
    })
    mkdirSync(join(dir, 'no-manifest'))
    const errors: string[] = []
    const found = discoverExtensions([{ dir, builtin: false }], (d) => errors.push(d))
    expect(found.map((f) => f.manifest.id)).toEqual(['good'])
    expect(found[0]).toMatchObject({ dir: join(dir, 'good'), builtin: false })
    expect(errors.sort()).toEqual([join(dir, 'broken'), join(dir, 'invalid')])
  })

  it('lets a built-in win when a user extension reuses its id', () => {
    const builtin = root({ git: manifest({ id: 'git', name: 'Builtin' }) })
    const user = root({ git: manifest({ id: 'git', name: 'Impostor' }) })
    const errors: string[] = []
    const found = discoverExtensions(
      [
        { dir: user, builtin: false },
        { dir: builtin, builtin: true },
      ],
      (_d, e) => errors.push(e),
    )
    expect(found).toHaveLength(1)
    expect(found[0].builtin).toBe(true)
    expect(found[0].manifest.name).toBe('Builtin')
    expect(errors).toEqual(["duplicate extension id 'git'"])
  })

  it('treats a missing root as empty', () => {
    expect(discoverExtensions([{ dir: '/nonexistent/pine-ext', builtin: false }])).toEqual([])
  })
})
