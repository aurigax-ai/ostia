import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVitest } from 'vitest/node'
import {
  E2E_CHANGED_REPEAT,
  E2E_HARNESS,
  ROOT,
  changedQuarantineFiles,
  coreTests,
  domFileReaders,
  e2eImports,
  e2eShards,
  e2eSpecs,
  e2eWeight,
  loadE2eMap,
  nodeFolderReaders,
  planAgainst,
  planChanges,
  planE2e,
  planOutput,
  planTests,
  splitChangedSpecs,
  unitTexts,
  vitestArgs,
} from './affectedTests.mjs'

const readers = {
  dom: ['src/renderer/lib/app/motion.test.tsx'],
  folders: {
    'e2e/': ['test/e2eImports.test.ts'],
    '.github/': ['src/main/updates/releasePackaging.test.ts'],
  },
  texts: {
    'test/e2eAreas.test.ts': "join(ROOT, 'test/e2eAreas')",
    'src/main/agents/skillFiles.test.ts': "'packages/extension-sdk/docs/EXTENSIONS.md'",
    'src/main/ports/portFixtures.test.ts': "join(root, 'test/fixtures/ports')",
    'src/renderer/lib/app/motion.test.tsx': "readFileSync('test/fixtures/ports/a.json')",
    'src/main/panes/paneIo.test.ts': "import './paneIo'",
  },
}

const map = {
  core: ['e2e/smoke.spec.ts:5', 'e2e/workflows.spec.ts:41'],
  areas: [
    { name: 'sandbox', paths: ['src/main/sandbox/'], specs: ['e2e/sandbox.spec.ts'] },
    {
      name: 'ssh',
      paths: ['src/extensions/ssh/', 'src/main/files/remoteFolder'],
      specs: ['e2e/ssh.spec.ts'],
    },
  ],
}

const imports = {
  'e2e/marketplace.spec.ts': ['e2e/helpers.ts', 'src/shared/extensions/marketplace.ts'],
  'e2e/smoke.spec.ts': ['e2e/helpers.ts'],
}

describe('planTests', () => {
  it('runs every test when a lockfile, config, test setup or script changes', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'package.json',
      'vitest.config.mts',
      'playwright.config.ts',
      'tsconfig.node.json',
      'test/setup.ts',
      'test/mocks/ostia.ts',
    ]) {
      expect(planTests(['src/renderer/lib/keyboard/keyPresets.ts', file], readers), file).toEqual({
        node: null,
        dom: null,
      })
    }
  })

  it('runs only the tests that name a non-code file', () => {
    expect(planTests(['test/e2eAreas/ssh.json'], readers)).toEqual({
      node: ['test/e2eAreas.test.ts'],
      dom: [],
    })
    expect(planTests(['packages/extension-sdk/docs/EXTENSIONS.md'], readers)).toEqual({
      node: ['src/main/agents/skillFiles.test.ts'],
      dom: [],
    })
    expect(planTests(['test/fixtures/ports/a.json'], readers)).toEqual({
      node: ['src/main/ports/portFixtures.test.ts'],
      dom: ['src/renderer/lib/app/motion.test.tsx'],
    })
  })

  it('runs every test for a build input, setup helper or tool config', () => {
    for (const file of [
      ...['extensions', 'tsnet', 'marketplace', 'artifact-runtime', 'info'].map(
        (name) => `scripts/build-${name}.mjs`,
      ),
      'packages/extension-sdk/scripts/build.mjs',
      'packages/extension-sdk/package.json',
      'packages/extension-sdk/template/package.json',
      'electron.vite.config.ts',
      'patches/swr@2.5.1.patch',
      'biome.json',
      'knip.json',
      '.jscpd.json',
      '.dependency-cruiser.json',
      '.dependency-cruiser-known-violations.json',
      'test/consoleGuard.ts',
      'test/nodeConsole.ts',
      'test/quarantine.mjs',
    ]) {
      expect(planTests([file], readers), file).toEqual({ node: null, dom: null })
    }
  })

  it('plans against the real test texts without the planner tests', () => {
    const texts = unitTexts()
    expect(Object.keys(texts)).not.toContain('test/affectedTests.test.ts')
    expect(Object.keys(texts)).not.toContain('test/e2eAreas.test.ts')
    const real = { ...readers, texts }
    expect(planTests(['packages/extension-sdk/docs/EXTENSIONS.md'], real)).toEqual({
      node: null,
      dom: null,
    })
    expect(planTests(['scripts/build-extensions.mjs'], real)).toEqual({ node: null, dom: null })
  })

  it('runs every test for a non-code file no test names', () => {
    expect(planTests(['scripts/build-extensions.mjs'], readers)).toEqual({ node: null, dom: null })
  })

  it('runs only related tests for a renderer change, plus the dom tests that read files', () => {
    expect(planTests(['src/renderer/lib/keyboard/keyPresets.ts'], readers)).toEqual({
      node: ['src/renderer/lib/keyboard/keyPresets.ts'],
      dom: ['src/renderer/lib/keyboard/keyPresets.ts', 'src/renderer/lib/app/motion.test.tsx'],
    })
  })

  it('runs every node test when a change reaches the built CLI, extensions or SDK', () => {
    for (const file of [
      'src/main/panes/paneIo.ts',
      'src/shared/types.ts',
      'src/cli/index.ts',
      'src/extensions/ssh/main.ts',
      'src/shared/app/dict.ts',
      'packages/extension-sdk/src/client/index.ts',
    ]) {
      expect(planTests([file], readers), file).toEqual({
        node: null,
        dom: [file, ...readers.dom],
      })
    }
  })

  it('runs the node tests that read e2e/ when only e2e files change', () => {
    expect(planTests(['e2e/blocks.spec.ts', 'e2e/helpers.ts'], readers)).toEqual({
      node: ['test/e2eImports.test.ts'],
      dom: [],
    })
  })

  it('runs only the tests that read workflows when only .github changes', () => {
    expect(
      planTests(['.github/workflows/ci.yml', '.github/actions/setup/action.yml'], readers),
    ).toEqual({ node: ['src/main/updates/releasePackaging.test.ts'], dom: [] })
  })

  it('runs the quarantine check and the tests whose entries changed for a quarantine change', () => {
    expect(
      planTests(['test/quarantine.json'], readers, [
        'src/main/tmux/keptShells.integration.test.ts',
        'src/renderer/components/settings/SettingsPanel.test.tsx',
        'e2e/sandbox.spec.ts',
      ]),
    ).toEqual({
      node: ['test/quarantine.test.ts', 'src/main/tmux/keptShells.integration.test.ts'],
      dom: ['src/renderer/components/settings/SettingsPanel.test.tsx'],
    })
  })

  it('runs nothing for root docs alone', () => {
    expect(planTests(['README.md', 'CONTRIBUTING.md'], readers)).toEqual({ node: [], dom: [] })
  })
})

describe('planE2e', () => {
  it('runs every spec when the e2e harness changes', () => {
    for (const file of E2E_HARNESS) {
      expect(planE2e(['src/main/sandbox/host.ts', file], map, imports), file).toBeNull()
    }
  })

  it('runs a changed spec and the specs importing a changed file', () => {
    expect(
      planE2e(['e2e/ssh.spec.ts', 'src/shared/extensions/marketplace.ts'], map, imports),
    ).toEqual(['e2e/marketplace.spec.ts', 'e2e/ssh.spec.ts'])
  })

  it('runs the specs of every area a changed file belongs to', () => {
    expect(
      planE2e(['src/main/sandbox/ptyWrap.ts', 'src/main/files/remoteFolders.ts'], map, imports),
    ).toEqual(['e2e/sandbox.spec.ts', 'e2e/ssh.spec.ts'])
  })

  it('runs the @core tests for a hub or any other unmapped file', () => {
    for (const file of ['src/main/app.ts', 'src/shared/app/dict.ts', 'package.json']) {
      expect(planE2e([file], map, imports), file).toEqual([
        'e2e/smoke.spec.ts:5',
        'e2e/workflows.spec.ts:41',
      ])
    }
  })

  it('runs a whole planned spec instead of its @core tests', () => {
    expect(planE2e(['src/main/app.ts', 'e2e/smoke.spec.ts'], map, imports)).toEqual([
      'e2e/smoke.spec.ts',
      'e2e/workflows.spec.ts:41',
    ])
  })

  it('runs no e2e for docs, unit tests, workflows and test tooling', () => {
    expect(
      planE2e(
        [
          'README.md',
          '.github/workflows/ci.yml',
          'src/main/sandbox/ptyWrap.test.ts',
          'src/renderer/lib/keyboard/chords.test.ts',
          'test/mocks/ostia.ts',
          'test/quarantine.json',
          'scripts/retry.sh',
          'vitest.config.mts',
        ],
        map,
        imports,
      ),
    ).toEqual([])
  })

  it('runs the e2e specs whose quarantine entries changed', () => {
    expect(
      planE2e(['test/quarantine.json'], map, imports, [
        'e2e/sandbox.spec.ts',
        'src/main/tmux/keptShells.integration.test.ts',
      ]),
    ).toEqual(['e2e/sandbox.spec.ts'])
  })
})

describe('changed specs', () => {
  it('runs a spec the pull request changed three times, and not again in the single run', () => {
    expect(E2E_CHANGED_REPEAT).toBe(3)
    expect(
      planOutput(planChanges(['e2e/smoke.spec.ts', 'src/main/sandbox/ptyWrap.ts'], 'HEAD')),
    ).toMatchObject({
      e2e: ['e2e/keep-shells-sandbox.spec.ts', 'e2e/sandbox.spec.ts'],
      e2eChanged: ['e2e/smoke.spec.ts'],
      e2eChangedRepeat: 3,
      e2eChangedShards: [1],
    })
  })

  it('runs a spec chosen only for its imports or its area once', () => {
    const changed = ['src/shared/extensions/marketplace.ts', 'src/main/sandbox/ptyWrap.ts']
    expect(splitChangedSpecs(planE2e(changed, map, imports), changed)).toEqual({
      e2e: ['e2e/marketplace.spec.ts', 'e2e/sandbox.spec.ts'],
      e2eChanged: [],
    })
    const plan = planOutput(
      planChanges(['packages/extension-sdk/src/manifest/marketplaceManifest.ts'], 'HEAD'),
    )
    expect(plan.e2e).toContain('e2e/marketplace.spec.ts')
    expect(plan.e2eChanged).toEqual([])
  })

  it('keeps the plan of a pull request that changes no spec', () => {
    const changed = ['src/main/sandbox/ptyWrap.ts', 'src/main/app.ts']
    const plan = planOutput(planChanges(changed, 'HEAD'))
    expect(plan.e2e).toEqual(planE2e(changed, { ...loadE2eMap(), core: coreTests() }, e2eImports()))
    expect(plan.e2eShards).toEqual(e2eShards(e2eWeight(plan.e2e ?? [])))
    expect(plan.e2eChanged).toEqual([])
  })

  it('repeats a changed spec next to a full run, and drops a deleted one', () => {
    expect(splitChangedSpecs(null, ['e2e/test.ts', 'e2e/ssh.spec.ts'])).toEqual({
      e2e: null,
      e2eChanged: ['e2e/ssh.spec.ts'],
    })
    expect(planChanges(['e2e/no-such.spec.ts'], 'HEAD').e2eChanged).toEqual([])
  })

  it('gives the repeated runs their own shards, counting each run', () => {
    const specs = Array.from({ length: 7 }, (_, index) => `e2e/s${index}.spec.ts`)
    const tests = { node: [], dom: [], e2e: [], e2eChanged: specs }
    expect(planOutput(tests).e2eChangedShards).toEqual([1, 2])
    expect(planOutput({ ...tests, e2eChanged: [] }).e2eChangedShards).toEqual([1])
  })
})

describe('changedQuarantineFiles', () => {
  it('names the files of entries that were added, removed or edited', () => {
    const kept = { file: 'a.test.ts', name: 'a', issue: 1, until: '2026-11-01' }
    const removed = { file: 'b.test.ts', name: 'b', issue: 1, until: '2026-11-01' }
    const edited = { file: 'e2e/c.spec.ts', name: 'c', issue: 1, until: '2026-11-01' }
    expect(
      changedQuarantineFiles(
        [kept, removed, edited],
        [kept, { ...edited, until: '2026-11-05' }, { ...kept, file: 'd.test.ts' }],
      ),
    ).toEqual(['b.test.ts', 'd.test.ts', 'e2e/c.spec.ts'])
  })
})

describe('e2eImports', () => {
  it('follows a spec through the e2e helpers into the shared code they import', () => {
    const graph = e2eImports()
    expect(graph['e2e/marketplace.spec.ts']).toContain('e2e/helpers.ts')
    expect(graph['e2e/marketplace.spec.ts']).toContain(
      'packages/extension-sdk/src/manifest/marketplaceManifest.ts',
    )
    expect(Object.keys(graph)).toEqual(e2eSpecs())
  })
})

describe('planChanges', () => {
  it('plans unit tests and e2e specs together', () => {
    expect(planChanges(['src/main/sandbox/ptyWrap.ts', 'e2e/smoke.spec.ts'], 'HEAD')).toEqual({
      node: null,
      dom: ['src/main/sandbox/ptyWrap.ts', ...domFileReaders()],
      e2e: ['e2e/keep-shells-sandbox.spec.ts', 'e2e/sandbox.spec.ts'],
      e2eChanged: ['e2e/smoke.spec.ts'],
    })
  })

  it('drops a deleted spec from the e2e plan', () => {
    expect(planChanges(['e2e/no-such.spec.ts'], 'HEAD').e2e).toEqual([])
  })

  it('runs the @core tests of the real specs for a hub change, never an empty list', () => {
    const { e2e } = planChanges(['src/main/app.ts'], 'HEAD')
    expect(e2e).toEqual(coreTests().sort())
    expect(e2e?.length).toBeGreaterThan(0)
    expect(e2e?.some((entry) => entry.includes('sandbox'))).toBe(false)
  })
})

describe('coreTests', () => {
  it('names every @core test by the file and line of its test call', () => {
    const found = coreTests()
    const marks = e2eSpecs().flatMap(
      (spec) => readFileSync(join(ROOT, spec), 'utf8').match(/@core\b/g) ?? [],
    )
    expect(found).toHaveLength(marks.length)
    expect(found.some((entry) => entry.startsWith('e2e/smoke.spec.ts:'))).toBe(true)
    for (const entry of found) {
      const [spec, line] = entry.split(':')
      const source = readFileSync(join(ROOT, spec), 'utf8').split('\n')
      expect(source[Number(line) - 1], entry).toMatch(/^test\(/)
    }
  })
})

describe('e2eWeight', () => {
  it('counts a spec as one and every five single tests as one more', () => {
    expect(e2eWeight([])).toBe(0)
    expect(e2eWeight(['e2e/a.spec.ts', 'e2e/b.spec.ts'])).toBe(2)
    expect(e2eWeight(['e2e/a.spec.ts', 'e2e/b.spec.ts:3'])).toBe(2)
    const tests = Array.from({ length: 33 }, (_, index) => `e2e/c.spec.ts:${index + 1}`)
    expect(e2eWeight(tests)).toBe(7)
    expect(e2eShards(e2eWeight(tests))).toEqual([1])
  })
})

describe('e2eShards', () => {
  it('runs up to 20 selected specs in one job and adds a shard per 20 more, up to four', () => {
    expect(e2eShards(0)).toEqual([1])
    expect(e2eShards(15)).toEqual([1])
    expect(e2eShards(20)).toEqual([1])
    expect(e2eShards(21)).toEqual([1, 2])
    expect(e2eShards(36)).toEqual([1, 2])
    expect(e2eShards(41)).toEqual([1, 2, 3])
    expect(e2eShards(61)).toEqual([1, 2, 3, 4])
    expect(e2eShards(126)).toEqual([1, 2, 3, 4])
  })

  it('is what the pull request plan step hands to the e2e matrix', () => {
    const workflow = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')
    expect(workflow).toContain(`echo "e2e_shards=$(jq -c '.e2eShards' <<< "$plan")"`)
    expect(workflow).toContain(
      'shards: ${{ steps.tests.outputs.e2e_shards || steps.plan.outputs.shards }}',
    )
  })
})

describe('planAgainst', () => {
  it('plans every test, and names the problem, when the base cannot be found', () => {
    const { tests, problem } = planAgainst('origin/no-such-branch')
    expect(tests).toEqual({ node: null, dom: null, e2e: null, e2eChanged: [] })
    expect(problem).toMatch(/no-such-branch/)
  })

  it('plans from the diff against the merge-base of a commit it can find', () => {
    const { tests, problem } = planAgainst('HEAD')
    expect(problem).toBeNull()
    expect(tests).toEqual({ node: [], dom: [], e2e: [], e2eChanged: [] })
  })
})

describe('domFileReaders', () => {
  it('lists the dom tests that read the source tree at run time', () => {
    const found = domFileReaders()
    expect(found).toContain('src/renderer/lib/app/motion.test.tsx')
    expect(found).toContain('src/renderer/lib/theme/typography.test.ts')
    expect(found).not.toContain('src/renderer/lib/layout/tree.test.ts')
  })
})

describe('nodeFolderReaders', () => {
  it('lists the node tests that read e2e/ and .github/ at run time', () => {
    const found = nodeFolderReaders()
    expect(found['e2e/']).toContain('test/e2eImports.test.ts')
    expect(found['e2e/']).toContain('test/e2eAreas.test.ts')
    expect(found['.github/']).toContain('src/main/updates/releasePackaging.test.ts')
    expect(found['.github/']).toContain('test/ciMergeQueue.test.ts')
    expect(found['.github/']).not.toContain('src/main/updates/releaseCheck.test.ts')
  })
})

describe('vitestArgs', () => {
  it('runs the whole project without a file list and related tests with one', () => {
    expect(vitestArgs('node', null)).toEqual(['run', '--project', 'node'])
    expect(vitestArgs('dom', ['src/renderer/a.ts'])).toEqual([
      'related',
      '--run',
      '--project',
      'dom',
      '--passWithNoTests',
      'src/renderer/a.ts',
    ])
  })
})

describe('vitest related', () => {
  it('follows a ?raw import of a markdown file to the test that imports it', async () => {
    const skill = join(ROOT, 'src/main/agents/skills/ostia-manager/SKILL.md')
    const vitest = await createVitest(
      'test',
      { root: ROOT, watch: false, project: ['node'], related: [skill] },
      {},
      {},
    )
    try {
      const related = await vitest.getRelevantTestSpecifications([
        'src/main/manager/managerAgent.test.ts',
      ])
      expect(related.map((spec) => spec.moduleId)).toEqual([
        join(ROOT, 'src/main/manager/managerAgent.test.ts'),
      ])
    } finally {
      await vitest.close()
    }
  })
})
