import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, areasOf } from './affectedTests.mjs'

type Area = { name: string; paths: string[]; specs: string[] }

const declared = JSON.parse(readFileSync(join(ROOT, 'test/e2eAreas.json'), 'utf8')) as {
  smoke: string[]
  areas: Area[]
}
const specs = readdirSync(join(ROOT, 'e2e'))
  .filter((name) => name.endsWith('.spec.ts'))
  .map((name) => `e2e/${name}`)
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
const named = [...declared.smoke, ...declared.areas.flatMap((area) => area.specs)]

describe('test/e2eAreas.json', () => {
  it('names only specs that exist', () => {
    expect(named.filter((spec) => !specs.includes(spec))).toEqual([])
  })

  it('reaches every spec through an area or the smoke set', () => {
    expect(specs.filter((spec) => !named.includes(spec))).toEqual([])
  })

  it('names only paths that match a tracked file', () => {
    const dead = declared.areas.flatMap((area) =>
      area.paths
        .filter((path) => !tracked.some((file) => file.startsWith(path)))
        .map((path) => `${area.name}: ${path}`),
    )
    expect(dead).toEqual([])
  })

  it('leaves the hub files every spec loads to the smoke set', () => {
    for (const hub of [
      'src/main/app.ts',
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/shared/types.ts',
      'src/renderer/App.tsx',
      'src/renderer/main.tsx',
      'src/renderer/index.css',
      'src/shared/dict.ts',
      'src/renderer/stores/layoutStore.ts',
      'src/renderer/stores/settingsStore.ts',
      'src/renderer/stores/workspacesStore.ts',
    ]) {
      expect(areasOf(hub, declared), hub).toEqual([])
    }
  })

  it('keeps the smoke set small', () => {
    expect(declared.smoke.length).toBeLessThanOrEqual(8)
  })
})
