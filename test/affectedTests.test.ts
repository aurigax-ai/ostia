import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createVitest } from 'vitest/node'
import { ROOT, domFileReaders, planTests, vitestArgs } from './affectedTests.mjs'

const readers = ['src/renderer/lib/motion.test.tsx']

describe('planTests', () => {
  it('runs every test when a lockfile, config, test setup, script or workflow changes', () => {
    for (const file of [
      'pnpm-lock.yaml',
      'package.json',
      'vitest.config.mts',
      'playwright.config.ts',
      'test/setup.ts',
      'scripts/build-extensions.mjs',
      '.github/workflows/ci.yml',
      'sdk-package/docs/EXTENSIONS.md',
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
      'src/extensions/git/main.ts',
      'src/renderer/i18n/dict.ts',
    ]) {
      expect(planTests([file], readers), file).toEqual({ node: null, dom: [file, ...readers] })
    }
  })

  it('ignores root docs and e2e specs, which no unit test imports', () => {
    expect(planTests(['README.md', 'e2e/blocks.spec.ts'], readers)).toEqual({
      node: [],
      dom: readers,
    })
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
