import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVitest } from 'vitest/node'
import {
  E2E_HARNESS,
  ROOT,
  changedQuarantineFiles,
  domFileReaders,
  e2eImports,
  e2eShards,
  e2eSpecs,
  nodeFolderReaders,
  planAgainst,
  planChanges,
  planE2e,
  planTests,
  vitestArgs,
} from './affectedTests.mjs'

const readers = {
  dom: ['src/renderer/lib/motion.test.tsx'],
  folders: {
    'e2e/': ['test/e2eImports.test.ts'],
    '.github/': ['src/main/releasePackaging.test.ts'],
  },
}

const map = {
  smoke: ['e2e/smoke.spec.ts'],
  areas: [
    { name: 'sandbox', paths: ['src/main/sandbox/'], specs: ['e2e/sandbox.spec.ts'] },
    {
      name: 'ssh',
      paths: ['src/extensions/ssh/', 'src/main/remoteFolder'],
      specs: ['e2e/ssh.spec.ts'],
    },
  ],
}

const imports = {
  'e2e/marketplace.spec.ts': ['e2e/helpers.ts', 'src/shared/marketplace.ts'],
  'e2e/smoke.spec.ts': ['e2e/helpers.ts'],
}

describe('planTests', () => {
  it('runs every test when a lockfile, config, test setup or script changes', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'package.json',
      'vitest.config.mts',
      'playwright.config.ts',
      'test/setup.ts',
      'test/mocks/ostia.ts',
      'scripts/build-extensions.mjs',
      'sdk/docs/EXTENSIONS.md',
    ]) {
      expect(planTests(['src/renderer/lib/keyPresets.ts', file], readers), file).toEqual({
        node: null,
        dom: null,
      })
    }
  })

  it('runs only related tests for a renderer change, plus the dom tests that read files', () => {
    expect(planTests(['src/renderer/lib/keyPresets.ts'], readers)).toEqual({
      node: ['src/renderer/lib/keyPresets.ts'],
      dom: ['src/renderer/lib/keyPresets.ts', 'src/renderer/lib/motion.test.tsx'],
    })
  })

  it('runs every node test when a change reaches the built CLI, extensions or SDK', () => {
    for (const file of [
      'src/main/paneIo.ts',
      'src/shared/types.ts',
      'src/cli/index.ts',
      'src/extensions/ssh/main.ts',
      'src/shared/dict.ts',
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
    ).toEqual({ node: ['src/main/releasePackaging.test.ts'], dom: [] })
  })

  it('runs the quarantine check and the tests whose entries changed for a quarantine change', () => {
    expect(
      planTests(['test/quarantine.json'], readers, [
        'src/main/tmux/keptShells.integration.test.ts',
        'src/renderer/components/SettingsPanel.test.tsx',
        'e2e/sandbox.spec.ts',
      ]),
    ).toEqual({
      node: ['test/quarantine.test.ts', 'src/main/tmux/keptShells.integration.test.ts'],
      dom: ['src/renderer/components/SettingsPanel.test.tsx'],
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
    expect(planE2e(['e2e/ssh.spec.ts', 'src/shared/marketplace.ts'], map, imports)).toEqual([
      'e2e/marketplace.spec.ts',
      'e2e/ssh.spec.ts',
    ])
  })

  it('runs the specs of every area a changed file belongs to', () => {
    expect(
      planE2e(['src/main/sandbox/ptyWrap.ts', 'src/main/remoteFolders.ts'], map, imports),
    ).toEqual(['e2e/sandbox.spec.ts', 'e2e/ssh.spec.ts'])
  })

  it('runs the smoke set for a hub or any other unmapped file', () => {
    for (const file of ['src/main/app.ts', 'src/shared/dict.ts', 'package.json']) {
      expect(planE2e([file], map, imports), file).toEqual(['e2e/smoke.spec.ts'])
    }
  })

  it('runs no e2e for docs, unit tests, workflows and test tooling', () => {
    expect(
      planE2e(
        [
          'README.md',
          '.github/workflows/ci.yml',
          'src/main/sandbox/ptyWrap.test.ts',
          'src/renderer/lib/chords.test.ts',
          'test/mocks/ostia.ts',
          'test/quarantine.json',
          'scripts/retry.sh',
          'vitest.workspace.mts',
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
    expect(graph['e2e/marketplace.spec.ts']).toContain('src/shared/marketplace.ts')
    expect(Object.keys(graph)).toEqual(e2eSpecs())
  })
})

describe('planChanges', () => {
  it('plans unit tests and e2e specs together', () => {
    expect(planChanges(['src/main/sandbox/ptyWrap.ts', 'e2e/smoke.spec.ts'], 'HEAD')).toEqual({
      node: null,
      dom: ['src/main/sandbox/ptyWrap.ts', ...domFileReaders()],
      e2e: ['e2e/keep-shells-sandbox.spec.ts', 'e2e/sandbox.spec.ts', 'e2e/smoke.spec.ts'],
    })
  })

  it('drops a deleted spec from the e2e plan', () => {
    expect(planChanges(['e2e/no-such.spec.ts'], 'HEAD').e2e).toEqual([])
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
    expect(tests).toEqual({ node: null, dom: null, e2e: null })
    expect(problem).toMatch(/no-such-branch/)
  })

  it('plans from the diff against the merge-base of a commit it can find', () => {
    const { tests, problem } = planAgainst('HEAD')
    expect(problem).toBeNull()
    expect(tests).toEqual({ node: [], dom: [], e2e: [] })
  })
})

describe('domFileReaders', () => {
  it('lists the dom tests that read the source tree at run time', () => {
    const found = domFileReaders()
    expect(found).toContain('src/renderer/lib/motion.test.tsx')
    expect(found).toContain('src/renderer/lib/typography.test.ts')
    expect(found).not.toContain('src/renderer/layout/tree.test.ts')
  })
})

describe('nodeFolderReaders', () => {
  it('lists the node tests that read e2e/ and .github/ at run time', () => {
    const found = nodeFolderReaders()
    expect(found['e2e/']).toContain('test/e2eImports.test.ts')
    expect(found['e2e/']).toContain('test/e2eAreas.test.ts')
    expect(found['.github/']).toContain('src/main/releasePackaging.test.ts')
    expect(found['.github/']).toContain('test/ciMergeQueue.test.ts')
    expect(found['.github/']).not.toContain('src/main/releaseCheck.test.ts')
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
    const skill = join(ROOT, 'src/main/agent/ostia-skill.md')
    const vitest = await createVitest(
      'test',
      { root: ROOT, watch: false, project: ['node'], related: [skill] },
      {},
      {},
    )
    try {
      const specs = await vitest.globTestSpecs(['src/main/managerAgent.test.ts'])
      const related = await vitest.filterTestsBySource(specs)
      expect(related.map((spec) => spec.moduleId)).toEqual([
        join(ROOT, 'src/main/managerAgent.test.ts'),
      ])
    } finally {
      await vitest.close()
    }
  })
})
