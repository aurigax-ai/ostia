import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { discoverExtensions } from './extensionManifest'

function manifest(id: string, verb?: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version: '1.0.0',
    api: '5.0',
    main: 'main.js',
    contributes: { commands: [{ id: 'run', title: 'Run' }], ...(verb ? { verb } : {}) },
  }
}

function root(entries: Record<string, Record<string, unknown>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'verb-builtin-'))
  for (const [name, raw] of Object.entries(entries)) {
    mkdirSync(join(dir, name))
    writeFileSync(join(dir, name, 'ostia.json'), JSON.stringify(raw))
  }
  return dir
}

describe('a built-in keeps its id and verb', () => {
  it('wins over a local or marketplace extension claiming them, whatever the order of the roots', () => {
    const local = root({
      a: manifest('graph'),
      b: manifest('thief', 'graphs'),
      c: manifest('copycat', 'graph'),
    })
    const builtin = root({ graphs: manifest('graphs', 'graph') })
    for (const roots of [
      [
        { dir: local, builtin: false },
        { dir: builtin, builtin: true },
      ],
      [
        { dir: builtin, builtin: true },
        { dir: local, builtin: false },
      ],
    ]) {
      const errors: string[] = []
      const found = discoverExtensions(roots, (_dir, error) => errors.push(error))
      expect(found.map((e) => e.manifest.id)).toEqual(['graphs'])
      expect(errors).toHaveLength(3)
    }
  })
})
