import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ROOT } from './affectedTests.mjs'

type Job = {
  needs?: string | string[]
  outputs?: Record<string, string>
  steps?: { env?: Record<string, string>; run?: string }[]
}

const workflow = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}

function fullFor(ctx: { event: string; code: string; e2eFull?: string }): boolean {
  const expression = (workflow.jobs.changes.outputs?.full ?? '')
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('github.ref_type', 'refType')
    .replaceAll('github.event_name', 'event')
    .replaceAll('inputs.full', 'inputsFull')
    .replaceAll('steps.filter.outputs.code', 'code')
    .replaceAll('steps.tests.outputs.e2e_full', 'e2eFull')
    .replaceAll('==', '===')
  const evaluate = new Function(
    'refType',
    'event',
    'inputsFull',
    'code',
    'e2eFull',
    `return ${expression}`,
  )
  return evaluate('branch', ctx.event, false, ctx.code, ctx.e2eFull ?? '') === true
}

function ciResultAccepts(opts: { code: boolean; full: boolean; e2e: string }): boolean {
  const step = workflow.jobs['ci-result'].steps?.find((candidate) =>
    candidate.run?.includes('jq -e'),
  )
  const run = step?.run ?? ''
  const program = run.slice(run.indexOf("'") + 1, run.lastIndexOf("'"))
  const needs = [workflow.jobs['ci-result'].needs ?? []].flat()
  const other = opts.code ? 'success' : 'skipped'
  const results = Object.fromEntries(
    needs.map((name) => [
      name,
      {
        result:
          name === 'changes'
            ? 'success'
            : name === 'e2e'
              ? opts.e2e
              : ['e2e-ptrace', 'build-macos', 'e2e-macos'].includes(name)
                ? 'skipped'
                : other,
      },
    ]),
  )
  try {
    execFileSync(
      'jq',
      [
        '-e',
        '--arg',
        'code',
        String(opts.code),
        '--arg',
        'full',
        String(opts.full),
        '--arg',
        'selected',
        'false',
        '--arg',
        'platform',
        'linux',
        '--arg',
        'gate',
        'false',
        program,
      ],
      {
        input: JSON.stringify(results),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, VERIFIED: 'false' },
      },
    )
    return true
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return false
    }
    throw error
  }
}

function platformFor(event: string, input = ''): string {
  const expression = (workflow.jobs.changes.outputs?.platform ?? '')
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('github.event_name', 'event')
    .replaceAll('inputs.platform', 'input')
    .replaceAll('==', '===')
  return new Function('event', 'input', `return ${expression}`)(event, input) as string
}

describe('merge queue e2e gating', () => {
  it('requires full for a merge_group that changes code', () => {
    expect(fullFor({ event: 'merge_group', code: 'true' })).toBe(true)
  })

  it('does not require full for a docs-only merge_group', () => {
    expect(fullFor({ event: 'merge_group', code: 'false' })).toBe(false)
  })

  it('leaves pull requests without full unless their plan asks for every spec', () => {
    expect(fullFor({ event: 'pull_request', code: 'true' })).toBe(false)
    expect(fullFor({ event: 'pull_request', code: 'true', e2eFull: 'true' })).toBe(true)
    expect(fullFor({ event: 'pull_request', code: 'false', e2eFull: 'true' })).toBe(false)
  })

  it('docs-only group: build and e2e skipped, ci-result accepts', () => {
    const full = fullFor({ event: 'merge_group', code: 'false' })
    expect(ciResultAccepts({ code: false, full, e2e: 'skipped' })).toBe(true)
  })

  it('code group: ci-result requires e2e success', () => {
    const full = fullFor({ event: 'merge_group', code: 'true' })
    expect(ciResultAccepts({ code: true, full, e2e: 'success' })).toBe(true)
    expect(ciResultAccepts({ code: true, full, e2e: 'skipped' })).toBe(false)
    expect(ciResultAccepts({ code: true, full, e2e: 'failure' })).toBe(false)
  })

  it('refuses a docs-only group that asked for the full run when e2e was skipped', () => {
    expect(ciResultAccepts({ code: false, full: true, e2e: 'skipped' })).toBe(false)
  })

  it('runs only Linux e2e in the merge queue unless dispatch overrides', () => {
    expect(platformFor('merge_group')).toBe('linux')
    expect(platformFor('merge_group', 'macos')).toBe('macos')
    expect(platformFor('pull_request')).toBe('all')
  })
})
