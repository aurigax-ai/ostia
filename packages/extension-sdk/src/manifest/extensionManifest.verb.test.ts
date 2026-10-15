import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { extensionManifestSchema } from '../cli/manifestSchema'
import { discoverExtensions, parseManifest } from './extensionManifest'

function manifest(id: string, verb?: string): Record<string, unknown> {
  return {
    id,
    name: id,
    version: '1.0.0',
    api: '4.0',
    main: 'main.js',
    contributes: {
      commands: [{ id: 'schema', title: 'Print the schema' }],
      ...(verb === undefined ? {} : { verb }),
    },
  }
}

describe('contributes.verb', () => {
  it('GRF-C128 a core verb, a core source, a bad verb or another extension’s id or verb is refused, naming the verb', () => {
    for (const verb of ['git', 'ports', 'pane', 'Graph!']) {
      const parsed = parseManifest(manifest('graphs', verb), '/x')
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain(verb)
      expect(extensionManifestSchema.safeParse(manifest('graphs', verb)).success).toBe(false)
    }
    const accepted = parseManifest(manifest('graphs', 'graph'), '/x')
    expect(accepted.ok && accepted.manifest.contributes.verb).toBe('graph')
    expect(extensionManifestSchema.safeParse(manifest('graphs', 'graph')).success).toBe(true)

    const root = mkdtempSync(join(tmpdir(), 'verb-root-'))
    const write = (dir: string, raw: Record<string, unknown>): void => {
      mkdirSync(join(root, dir))
      writeFileSync(join(root, dir, 'ostia.json'), JSON.stringify(raw))
    }
    write('a-graphs', manifest('graphs', 'graph'))
    write('b-graph', manifest('graph'))
    write('c-other', manifest('other', 'graphs'))
    const errors: string[] = []
    const found = discoverExtensions([{ dir: root, builtin: true }], (_dir, error) =>
      errors.push(error),
    )
    expect(found.map((e) => e.manifest.id)).toEqual(['graphs'])
    expect(errors).toHaveLength(2)
    expect(errors.join('\n')).toContain("'graph'")
    expect(errors.join('\n')).toContain("'graphs'")
  })
})
