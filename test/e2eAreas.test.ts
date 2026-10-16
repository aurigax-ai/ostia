import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ROOT, areasOf, coreTests, loadE2eMap, specOf } from './affectedTests.mjs'

type Area = { name: string; paths: string[]; specs: string[] }

const AREAS_DIR = join(ROOT, 'test/e2eAreas')
const files = readdirSync(AREAS_DIR).filter((name) => name.endsWith('.json'))
const declared = loadE2eMap() as { areas: Area[] }
const specs = readdirSync(join(ROOT, 'e2e'))
  .filter((name) => name.endsWith('.spec.ts'))
  .map((name) => `e2e/${name}`)
const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n')
const named = declared.areas.flatMap((area) => area.specs)
const core = coreTests().map(specOf)

describe('test/e2eAreas', () => {
  it('names each file after its area and keeps its lists sorted and unique', () => {
    for (const file of files) {
      const text = readFileSync(join(AREAS_DIR, file), 'utf8')
      const area = JSON.parse(text) as Area
      expect(file, file).toBe(`${area.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`)
      expect(area.paths, file).toEqual([...new Set(area.paths)].sort())
      expect(area.specs, file).toEqual([...new Set(area.specs)].sort())
      expect(text, file).toBe(`${JSON.stringify(area, null, 2)}\n`)
    }
  })

  it('names only specs that exist', () => {
    expect(named.filter((spec) => !specs.includes(spec))).toEqual([])
  })

  it('reaches every spec through an area or a @core test', () => {
    expect(specs.filter((spec) => !named.includes(spec) && !core.includes(spec))).toEqual([])
  })

  it('names only paths that match a tracked file', () => {
    const dead = declared.areas.flatMap((area) =>
      area.paths
        .filter((path) => !tracked.some((file) => file.startsWith(path)))
        .map((path) => `${area.name}: ${path}`),
    )
    expect(dead).toEqual([])
  })

  it('leaves the hub files every spec loads to the @core tests', () => {
    for (const hub of [
      'src/main/app.ts',
      'src/main/boot/agentServices.ts',
      'src/main/boot/appState.ts',
      'src/main/boot/bootPhases.ts',
      'src/main/boot/browserServices.ts',
      'src/main/boot/confinedServices.ts',
      'src/main/boot/featureServices.ts',
      'src/main/boot/paneServices.ts',
      'src/main/boot/quitServices.ts',
      'src/main/boot/sharedServices.ts',
      'src/main/boot/windowShell.ts',
      'src/main/boot/workspaceServices.ts',
      'src/main/index.ts',
      'src/preload/index.ts',
      'src/shared/types.ts',
      'src/renderer/App.tsx',
      'src/renderer/main.tsx',
      'src/renderer/index.css',
      'src/shared/app/dict.ts',
      'src/renderer/stores/workspaces/layoutStore.ts',
      'src/renderer/stores/app/settingsStore.ts',
      'src/renderer/stores/workspaces/workspacesStore.ts',
    ]) {
      expect(areasOf(hub, declared), hub).toEqual([])
    }
  })
})
