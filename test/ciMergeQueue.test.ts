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
  const step = workflow.jobs.e2e.steps?.find((candidate) =>
    candidate.run?.includes('pnpm test:e2e'),
  )
  const shard = (step?.env?.SHARD ?? '')
    .replaceAll('${{ matrix.shard }}', '1')
    .replaceAll('${{ strategy.job-total }}', '2')
  return bash(step?.run ?? '', {
    PATH: `${bin}:${process.env.PATH}`,
    SHARD: shard,
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
    .replaceAll('needs.changes.outputs.code', "'true'")
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

function ciResultAccepts(opts: {
  code: boolean
  full: boolean
  e2e: string
  changed?: boolean
  results?: Record<string, string>
}): boolean {
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
          opts.results?.[name] ??
          (name === 'changes'
            ? 'success'
            : name === 'e2e'
              ? opts.e2e
              : ['e2e-ptrace', 'e2e-changed', 'build-macos', 'e2e-macos'].includes(name)
                ? 'skipped'
                : other),
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
        '--arg',
        'changed',
        String(opts.changed ?? false),
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

type Runners = { linux: string; linux_small: string; linux_heavy: string; macos: string }

function stepOutputs(name: string, run: string, env: Record<string, string>) {
  const output = join(root, `${name}-output`)
  writeFileSync(output, '')
  bash(run, { ...env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: join(root, `${name}-summary`) })
  const lines = readFileSync(output, 'utf8').split('\n').filter(Boolean)
  return Object.fromEntries(
    lines.map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
  )
}

function runnersFor(ctx: {
  event: string
  trusted: boolean
  refType?: string
  linuxSwitch?: string
  selfHosted?: boolean
}): Runners {
  const run = workflow.jobs.changes.steps?.find((step) => step.id === 'runner')?.run ?? ''
  return stepOutputs('runner', run, {
    TRUSTED: String(ctx.trusted),
    LINUX_SWITCH: ctx.linuxSwitch ?? '',
    MACOS_SWITCH: 'off',
    REF_TYPE: ctx.refType ?? 'branch',
    EVENT: ctx.event,
    SELF_HOSTED: ctx.selfHosted === undefined ? '' : String(ctx.selfHosted),
  }) as Runners
}

function testsStepFor(plan: object) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'node'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(plan)}'\n`)
  chmodSync(join(bin, 'node'), 0o755)
  const run = workflow.jobs.changes.steps?.find((step) => step.id === 'tests')?.run ?? ''
  return stepOutputs('tests', run, { PATH: `${bin}:${process.env.PATH}`, BASE_SHA: 'base' })
}

function changedArgs(env: { specs: string; repeat: string; selfHosted?: boolean }) {
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'pnpm'), '#!/bin/sh\nshift\nprintf \'%s\\n\' "$@"\n')
  chmodSync(join(bin, 'pnpm'), 0o755)
  const step = workflow.jobs['e2e-changed'].steps?.find((candidate) =>
    candidate.run?.includes('pnpm test:e2e'),
  )
  return bash(step?.run ?? '', {
    PATH: `${bin}:${process.env.PATH}`,
    SHARD: '1/1',
    SPECS: env.specs,
    REPEAT: env.repeat,
    SELF_HOSTED: String(env.selfHosted ?? false),
    PTRACE_E2E: workflow.env.PTRACE_E2E,
  })
    .trim()
    .split('\n')
}

function runsOn(name: string): string {
  return String((workflow.jobs[name] as { 'runs-on'?: string })['runs-on'])
}

describe('runners', () => {
  const hosted = '"ubuntu-24.04"'
  const ostia = '"ostia-linux"'
  const small = '"ostia-linux-small"'

  it('keeps the heavy pull request jobs on GitHub-hosted runners and the light ones at home', () => {
    expect(runnersFor({ event: 'pull_request', trusted: true })).toMatchObject({
      linux: ostia,
      linux_small: small,
      linux_heavy: hosted,
    })
    expect(runnersFor({ event: 'pull_request', trusted: false })).toMatchObject({
      linux: hosted,
      linux_small: hosted,
      linux_heavy: hosted,
    })
  })

  it('runs a manual run on GitHub-hosted runners unless it asks for the self-hosted ones', () => {
    expect(runnersFor({ event: 'workflow_dispatch', trusted: true })).toMatchObject({
      linux: ostia,
      linux_heavy: hosted,
    })
    expect(
      runnersFor({ event: 'workflow_dispatch', trusted: true, selfHosted: false }).linux_heavy,
    ).toBe(hosted)
    expect(
      runnersFor({ event: 'workflow_dispatch', trusted: true, selfHosted: true }).linux_heavy,
    ).toBe(ostia)
    expect(
      runnersFor({ event: 'workflow_dispatch', trusted: false, selfHosted: true }).linux_heavy,
    ).toBe(hosted)
    expect(
      runnersFor({
        event: 'workflow_dispatch',
        trusted: true,
        selfHosted: true,
        linuxSwitch: 'off',
      }).linux_heavy,
    ).toBe(hosted)
    expect(
      runnersFor({ event: 'workflow_dispatch', trusted: true, selfHosted: true, refType: 'tag' })
        .linux_heavy,
    ).toBe(hosted)
  })

  it('leaves pushes, the merge queue, the nightly run and tags where they were', () => {
    const cases = [
      { ctx: { event: 'push', trusted: true }, linux: ostia, small },
      { ctx: { event: 'push', trusted: true, refType: 'tag' }, linux: hosted, small: hosted },
      { ctx: { event: 'push', trusted: true, linuxSwitch: 'off' }, linux: hosted, small: hosted },
      { ctx: { event: 'merge_group', trusted: false }, linux: hosted, small: hosted },
      { ctx: { event: 'schedule', trusted: false }, linux: hosted, small: hosted },
    ]
    for (const { ctx, linux, small: linuxSmall } of cases) {
      expect(runnersFor(ctx), JSON.stringify(ctx)).toEqual({
        linux,
        linux_small: linuxSmall,
        linux_heavy: linux,
        macos: '"macos-26"',
      })
    }
  })

  it('puts e2e and unit-dom on the heavy runner, static and build on the light one', () => {
    for (const name of ['e2e', 'e2e-changed', 'unit-dom']) {
      expect(runsOn(name), name).toBe('${{ fromJSON(needs.changes.outputs.linux_heavy) }}')
    }
    for (const name of ['static', 'build']) {
      expect(runsOn(name), name).toBe('${{ fromJSON(needs.changes.outputs.linux) }}')
    }
    for (const name of ['ci-result', 'e2e-report']) {
      expect(runsOn(name), name).toBe('${{ fromJSON(needs.changes.outputs.linux_small) }}')
    }
  })

  it('runs e2e-ptrace only when the e2e shards run on a self-hosted runner', () => {
    expect(workflow.jobs['e2e-ptrace'].if).toContain(
      `needs.changes.outputs.linux_heavy != '"ubuntu-24.04"'`,
    )
    expect(workflow.jobs['e2e-ptrace'].if).not.toContain('outputs.linux ')
  })
})

describe('changed specs run three times on a pull request', () => {
  const plan = {
    node: [],
    dom: [],
    e2e: ['e2e/marketplace.spec.ts'],
    e2eShards: [1],
    e2eChanged: ['e2e/smoke.spec.ts', 'e2e/ssh.spec.ts'],
    e2eChangedRepeat: 3,
    e2eChangedShards: [1],
  }

  it('hands the changed specs, their shards and the repeat count to e2e-changed', () => {
    expect(testsStepFor(plan)).toMatchObject({
      e2e_specs: 'e2e/marketplace.spec.ts',
      changed_specs: 'e2e/smoke.spec.ts e2e/ssh.spec.ts',
      changed_shards: '[1]',
      changed_repeat: '3',
    })
    expect(workflow.jobs.changes.outputs).toMatchObject({
      changed_specs: '${{ steps.tests.outputs.changed_specs }}',
    })
  })

  it('plans no repeated job when the pull request changes no spec', () => {
    const outputs = testsStepFor({ ...plan, e2eChanged: [], e2eChangedShards: [1] })
    expect(outputs.e2e_specs).toBe('e2e/marketplace.spec.ts')
    expect(outputs).not.toHaveProperty('changed_specs')
  })

  it('still repeats the changed specs when the plan asks for every spec', () => {
    expect(testsStepFor({ ...plan, e2e: null, e2eShards: null })).toMatchObject({
      e2e_full: 'true',
      changed_specs: 'e2e/smoke.spec.ts e2e/ssh.spec.ts',
    })
  })

  it('runs the changed specs with --repeat-each from the plan', () => {
    expect(changedArgs({ specs: 'e2e/smoke.spec.ts e2e/ssh.spec.ts', repeat: '3' })).toEqual([
      'e2e/smoke.spec.ts',
      'e2e/ssh.spec.ts',
      '--shard=1/1',
      '--repeat-each=3',
    ])
    expect(changedArgs({ specs: 'e2e/sandbox.spec.ts', repeat: '3', selfHosted: true })).toEqual([
      'e2e/sandbox.spec.ts',
      '--shard=1/1',
      '--repeat-each=3',
      '--grep-invert',
      workflow.env.PTRACE_E2E,
    ])
  })

  it('blocks ci-result on the repeated runs, and accepts them skipped when none are planned', () => {
    const pullRequest = { code: true, full: false, e2e: 'skipped' }
    expect(
      ciResultAccepts({ ...pullRequest, changed: true, results: { 'e2e-changed': 'success' } }),
    ).toBe(true)
    expect(
      ciResultAccepts({ ...pullRequest, changed: true, results: { 'e2e-changed': 'failure' } }),
    ).toBe(false)
    expect(
      ciResultAccepts({ ...pullRequest, changed: true, results: { 'e2e-changed': 'skipped' } }),
    ).toBe(false)
    expect(ciResultAccepts({ ...pullRequest, results: { 'e2e-changed': 'skipped' } })).toBe(true)
  })
})

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

describe('quality and security gates', () => {
  const pullRequest = { code: true, full: false, e2e: 'skipped' }

  it('runs knip, dependency-cruiser and jscpd in the static job', () => {
    const runs = workflow.jobs.static.steps?.map((step) => step.run) ?? []
    expect(runs).toContain('pnpm quality')
  })

  it('blocks ci-result when the workflow and spelling checks fail', () => {
    expect(ciResultAccepts(pullRequest)).toBe(true)
    expect(ciResultAccepts({ ...pullRequest, results: { hygiene: 'failure' } })).toBe(false)
    expect(ciResultAccepts({ ...pullRequest, results: { hygiene: 'skipped' } })).toBe(false)
  })

  it('blocks ci-result on a failed dependency review and accepts it skipped outside a pull request', () => {
    expect(jobRuns('dependency-review', { event: 'pull_request' })).toBe(true)
    expect(jobRuns('dependency-review', { event: 'merge_group' })).toBe(false)
    expect(ciResultAccepts({ ...pullRequest, results: { 'dependency-review': 'failure' } })).toBe(
      false,
    )
    expect(ciResultAccepts({ ...pullRequest, results: { 'dependency-review': 'skipped' } })).toBe(
      true,
    )
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
