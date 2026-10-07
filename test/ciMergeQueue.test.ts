import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { ROOT } from './quarantine.mjs'

type Job = {
  needs?: string | string[]
  outputs?: Record<string, string>
  steps?: { env?: Record<string, string>; run?: string }[]
}

const workflow = parse(readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8')) as {
  jobs: Record<string, Job>
}

function fullFor(ctx: { event: string; code: string; harness?: string }): boolean {
  const expression = (workflow.jobs.changes.outputs?.full ?? '')
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replaceAll('github.ref_type', 'refType')
    .replaceAll('github.event_name', 'event')
    .replaceAll('inputs.full', 'inputsFull')
    .replaceAll('steps.filter.outputs.code', 'code')
    .replaceAll('steps.e2e_paths.outputs.harness', 'harness')
    .replaceAll('==', '===')
  const evaluate = new Function(
    'refType',
    'event',
    'inputsFull',
    'code',
    'harness',
    `return ${expression}`,
  )
  return evaluate('branch', ctx.event, false, ctx.code, ctx.harness ?? '') === true
}

function ciResultAccepts(opts: { code: boolean; full: boolean; e2e: string }): boolean {
  const step = workflow.jobs['ci-result'].steps?.find((candidate) =>
    candidate.run?.includes('jq -e'),
  )
  const run = step?.run ?? ''
  const program = run.slice(run.indexOf("'") + 1, run.lastIndexOf("'"))
  const needs = [
    'changes',
    'static',
    'unit',
    'unit-dom',
    'build',
    'e2e',
    'e2e-ptrace',
    'e2e-report',
  ]
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
              : name === 'e2e-ptrace'
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
        'changed',
        'false',
        '--arg',
        'platform',
        'linux',
        program,
      ],
      { input: JSON.stringify(results), stdio: ['pipe', 'pipe', 'pipe'] },
    )
    return true
  } catch {
    return false
  }
}

describe('merge queue e2e gating', () => {
  it('requires full for a merge_group that changes code', () => {
    expect(fullFor({ event: 'merge_group', code: 'true' })).toBe(true)
  })

  it('does not require full for a docs-only merge_group', () => {
    expect(fullFor({ event: 'merge_group', code: 'false' })).toBe(false)
  })

  it('leaves pull requests without full unless the harness changed', () => {
    expect(fullFor({ event: 'pull_request', code: 'true' })).toBe(false)
    expect(fullFor({ event: 'pull_request', code: 'true', harness: 'true' })).toBe(true)
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

  it('old condition (full for every merge_group) would fail a docs-only group', () => {
    expect(ciResultAccepts({ code: false, full: true, e2e: 'skipped' })).toBe(false)
  })
})
