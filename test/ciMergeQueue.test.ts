import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ROOT } from './affectedTests.mjs'

type Job = {
  if?: string
  needs?: string | string[]
  'continue-on-error'?: boolean | string
  outputs?: Record<string, string>
  steps?: { id?: string; env?: Record<string, string>; run?: string }[]
}

const workflow = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
  env: Record<string, string>
  jobs: Record<string, Job>
}

const root = mkdtempSync(join(tmpdir(), 'ostia-ci-'))
const bin = join(root, 'bin')
afterAll(() => rmSync(root, { recursive: true, force: true }))

function bash(script: string, env: Record<string, string>): string {
  return execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  })
}

type Plan = { shards: string; grep: string; grep_invert: string; specs: string }

function planFor(ctx: { event: string; refType?: string; specs?: string }): Plan {
  const output = join(root, `plan-${ctx.event}-${ctx.refType ?? 'branch'}`)
  writeFileSync(output, '')
  const run = workflow.jobs.changes.steps?.find((step) => step.id === 'plan')?.run ?? ''
  bash(run, {
    SPECS: ctx.specs ?? '',
    REPEAT: '1',
    EVENT: ctx.event,
    REF_TYPE: ctx.refType ?? 'branch',
    GITHUB_OUTPUT: output,
  })
  const lines = readFileSync(output, 'utf8').split('\n').filter(Boolean)
  return Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  ) as Plan
}

function e2eArgs(env: {
  specs?: string
  grep?: string
  grepInvert?: string
  selfHosted?: boolean
}) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nshift\nprintf \'%s\\n\' "$@"\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  const run = (
    workflow.jobs.e2e.steps?.find((step) => step.run?.includes('pnpm test:e2e'))?.run ?? ''
  )
    .replaceAll('${{ matrix.shard }}', '1')
    .replaceAll('${{ strategy.job-total }}', '2')
  return bash(run, {
    PATH: `${bin}:${process.env.PATH}`,
    SPECS: env.specs ?? '',
    REPEAT: '1',
    GREP: env.grep ?? '',
    GREP_INVERT: env.grepInvert ?? '',
    SELF_HOSTED: String(env.selfHosted ?? false),
    PTRACE_E2E: workflow.env.PTRACE_E2E,
  })
    .trim()
    .split('\n')
}

function jobRuns(name: string, ctx: { event: string; refType?: string }): boolean {
  const expression = (workflow.jobs[name].if ?? 'true')
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('github.event_name', 'event')
    .replaceAll('github.ref_type', 'refType')
    .replaceAll('==', '===')
  return new Function('event', 'refType', `return ${expression}`)(
    ctx.event,
    ctx.refType ?? 'branch',
  ) as boolean
}

function fullFor(ctx: {
  event: string
  code: string
  e2eFull?: string
  refType?: string
  inputsFull?: boolean
}): boolean {
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
  return (
    evaluate(
      ctx.refType ?? 'branch',
      ctx.event,
      ctx.inputsFull ?? false,
      ctx.code,
      ctx.e2eFull ?? '',
    ) === true
  )
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

describe('e2e plan for each event', () => {
  it('runs every Linux spec in four shards for a pull request whose plan asks for all of them', () => {
    expect(fullFor({ event: 'pull_request', code: 'true', e2eFull: 'true' })).toBe(true)
    expect(planFor({ event: 'pull_request' })).toMatchObject({
      shards: '[1,2,3,4]',
      grep: '',
      grep_invert: '',
    })
  })

  it('runs the @core tests in two shards in the merge queue', () => {
    expect(fullFor({ event: 'merge_group', code: 'true' })).toBe(true)
    expect(planFor({ event: 'merge_group' })).toMatchObject({
      specs: '',
      shards: '[1,2]',
      grep: '@core',
      grep_invert: '',
    })
  })

  it('runs no e2e on a push to main', () => {
    expect(fullFor({ event: 'push', code: 'true' })).toBe(false)
    expect(ciResultAccepts({ code: true, full: false, e2e: 'skipped' })).toBe(true)
  })

  it('runs every spec in six shards every night', () => {
    expect(fullFor({ event: 'schedule', code: '' })).toBe(true)
    expect(planFor({ event: 'schedule' })).toMatchObject({
      shards: '[1,2,3,4,5,6]',
      grep: '',
      grep_invert: '',
    })
  })

  it('runs every spec but @experimental in six shards on a tag', () => {
    expect(fullFor({ event: 'push', code: '', refType: 'tag' })).toBe(true)
    expect(planFor({ event: 'push', refType: 'tag' })).toMatchObject({
      shards: '[1,2,3,4,5,6]',
      grep: '',
      grep_invert: '@experimental',
    })
  })

  it('keeps four shards for a dispatch, and one job for the specs it names', () => {
    expect(fullFor({ event: 'workflow_dispatch', code: '', inputsFull: true })).toBe(true)
    expect(planFor({ event: 'workflow_dispatch' })).toMatchObject({
      shards: '[1,2,3,4]',
      grep: '',
      grep_invert: '',
    })
    expect(
      planFor({ event: 'workflow_dispatch', specs: '--grep @core', refType: 'tag' }),
    ).toMatchObject({ specs: '--grep @core', shards: '[1]', grep: '', grep_invert: '' })
  })
})

describe('e2e command line', () => {
  it('passes the planned grep, and the planned specs as they are', () => {
    expect(e2eArgs({ grep: '@core' })).toEqual([
      '--shard=1/2',
      '--repeat-each=1',
      '--grep',
      '@core',
    ])
    expect(e2eArgs({ specs: 'e2e/smoke.spec.ts e2e/workflows.spec.ts:41' })).toEqual([
      'e2e/smoke.spec.ts',
      'e2e/workflows.spec.ts:41',
      '--shard=1/2',
      '--repeat-each=1',
    ])
  })

  it('joins the planned grep-invert with the ptrace test on a self-hosted runner', () => {
    expect(e2eArgs({ grepInvert: '@experimental' })).toEqual([
      '--shard=1/2',
      '--repeat-each=1',
      '--grep-invert',
      '@experimental',
    ])
    expect(e2eArgs({ selfHosted: true })).toEqual([
      '--shard=1/2',
      '--repeat-each=1',
      '--grep-invert',
      workflow.env.PTRACE_E2E,
    ])
    expect(e2eArgs({ grepInvert: '@experimental', selfHosted: true })).toEqual([
      '--shard=1/2',
      '--repeat-each=1',
      '--grep-invert',
      `@experimental|${workflow.env.PTRACE_E2E}`,
    ])
  })
})

describe('nightly race and macOS core jobs', () => {
  const events = [
    { event: 'pull_request' },
    { event: 'merge_group' },
    { event: 'push' },
    { event: 'schedule' },
    { event: 'push', refType: 'tag' },
    { event: 'workflow_dispatch' },
  ]

  it('runs e2e-race only at night, repeating the @race tests ten times', () => {
    expect(events.filter((ctx) => jobRuns('e2e-race', ctx))).toEqual([{ event: 'schedule' }])
    const runs = workflow.jobs['e2e-race'].steps?.map((step) => step.run ?? '') ?? []
    expect(runs).toContain('pnpm test:e2e --grep @race --repeat-each=10')
  })

  it('runs e2e-macos-core at night and on tags', () => {
    expect(events.filter((ctx) => jobRuns('e2e-macos-core', ctx))).toEqual([
      { event: 'schedule' },
      { event: 'push', refType: 'tag' },
    ])
    const runs = workflow.jobs['e2e-macos-core'].steps?.map((step) => step.run ?? '') ?? []
    expect(runs).toContain('pnpm test:e2e --grep @core')
  })

  it('lets neither block: ci-result does not wait for them and they may fail', () => {
    const needs = [workflow.jobs['ci-result'].needs ?? []].flat()
    for (const name of ['e2e-race', 'e2e-macos-core']) {
      expect(needs, name).not.toContain(name)
      expect(workflow.jobs[name]['continue-on-error'], name).toBe(true)
    }
    expect(needs).toContain('e2e')
  })
})
