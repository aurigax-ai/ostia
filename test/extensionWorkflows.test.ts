import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const root = join(__dirname, '..')

interface Step {
  uses?: string
  run?: string
  env?: Record<string, string>
  with?: Record<string, unknown>
}
interface Job {
  environment?: string
  permissions?: Record<string, string>
  steps: Step[]
}

function workflow(path: string): { text: string; jobs: Record<string, Job> } {
  const text = readFileSync(join(root, path), 'utf8')
  return { text, jobs: parse(text).jobs }
}

function usesOf(jobs: Record<string, Job>): string[] {
  return Object.values(jobs).flatMap((job) => job.steps.flatMap((step) => step.uses ?? []))
}

describe('extension-release.yml', () => {
  const { text, jobs } = workflow('.github/workflows/extension-release.yml')

  it('never makes an extension release the latest release of the repository', () => {
    expect(text).toContain('gh release create')
    expect(text).toContain('--latest=false')
  })

  it('keeps the signing key in a job of its own that runs no extension code', () => {
    const holders = Object.entries(jobs).filter(([, job]) =>
      JSON.stringify(job).includes('OSTIA_EXTENSION_SIGNING_KEY'),
    )
    expect(holders.map(([name]) => name)).toEqual(['sign'])
    expect(jobs.sign?.environment).toBe('extension-release')
    expect(jobs.build?.environment).toBeUndefined()
    const commands = (jobs.sign?.steps ?? []).map((step) => step.run ?? '').join('\n')
    for (const forbidden of ['vitest', 'pnpm typecheck', 'build.mjs', 'marketplace-checkout']) {
      expect(commands).not.toContain(forbidden)
    }
    const setup = jobs.sign?.steps.find((step) => step.uses === './.github/actions/setup')
    expect(setup?.with).toMatchObject({ electron: 'false', go: 'false', cache: 'false' })
  })

  it('builds on a marketplace commit it pins and records', () => {
    const checkout = jobs.build?.steps.find(
      (step) => step.with?.repository === 'aurigax-ai/ostia-extensions',
    )
    expect(checkout?.with?.ref).toContain('steps.pin.outputs.sha')
  })

  it('caches nothing', () => {
    for (const job of Object.values(jobs)) {
      const setup = job.steps.find((step) => step.uses === './.github/actions/setup')
      if (setup) expect(setup.with?.cache).toBe('false')
    }
  })
})

describe('sdk-release.yml', () => {
  const { jobs } = workflow('.github/workflows/sdk-release.yml')

  it('publishes from a reviewed environment, with no cache', () => {
    expect(jobs.sdk?.environment).toBe('sdk-release')
    expect(jobs.sdk?.permissions).toMatchObject({ 'id-token': 'write' })
    const node = jobs.sdk?.steps.find((step) => step.uses?.startsWith('actions/setup-node@'))
    expect(node?.with?.['package-manager-cache']).toBe(false)
    const setup = jobs.sdk?.steps.find((step) => step.uses === './.github/actions/setup')
    expect(setup?.with?.cache).toBe('false')
  })
})

describe('the marketplace workflows', () => {
  for (const path of [
    'marketplace/.github/workflows/sync.yml',
    'marketplace/.github/workflows/ci.yml',
  ]) {
    it(`${path} pins every action to a commit and keeps no credentials or cache`, () => {
      const { text, jobs } = workflow(path)
      for (const used of usesOf(jobs)) expect(used).toMatch(/@[0-9a-f]{40}$/)
      for (const job of Object.values(jobs)) {
        const checkout = job.steps.find((step) => step.uses?.startsWith('actions/checkout@'))
        expect(checkout?.with?.['persist-credentials']).toBe(false)
      }
      if (path.endsWith('sync.yml')) expect(text).not.toMatch(/cache: pnpm/)
    })
  }

  it('sync.yml passes release names to the script and never into inline JavaScript', () => {
    const { text } = workflow('marketplace/.github/workflows/sync.yml')
    expect(text).not.toMatch(/node -p/)
    expect(text).toContain('sync-releases.mjs unseen')
  })

  it('sync.yml pushes what it placed before it fails on what it could not', () => {
    const { text } = workflow('marketplace/.github/workflows/sync.yml')
    expect(text.indexOf('git push')).toBeGreaterThan(-1)
    expect(text.indexOf('git push')).toBeLessThan(text.indexOf('Fail on the releases'))
    expect(text).toContain('test ! -s failures.txt')
  })
})
