import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, e2eShards, e2eWeight, planAgainst, vitestArgs } from '../test/affectedTests.mjs'

const USAGE = 'usage: node scripts/affectedTests.mjs plan <base-ref> | run <node|dom> [plan]'

function plan(baseRef) {
  const { tests, problem } = planAgainst(baseRef)
  if (problem) console.error(`cannot plan against ${baseRef}, running every test: ${problem}`)
  for (const project of ['node', 'dom']) {
    const files = tests[project]
    console.error(
      `${project}: ${files === null ? 'every test' : `tests related to ${files.length} files`}`,
    )
  }
  console.error(`e2e: ${tests.e2e === null ? 'every spec' : `${tests.e2e.length} specs`}`)
  const shards = tests.e2e === null ? null : e2eShards(e2eWeight(tests.e2e))
  console.log(JSON.stringify({ ...tests, e2eShards: shards }))
}

function run(project, planText) {
  const planned = planText ? JSON.parse(planText)[project] : null
  const files = planned === null ? null : planned.filter((file) => existsSync(join(ROOT, file)))
  if (files?.length === 0) {
    console.log(`${project}: no changed file can affect these tests`)
    return
  }
  const result = spawnSync('pnpm', ['exec', 'vitest', ...vitestArgs(project, files)], {
    cwd: ROOT,
    stdio: 'inherit',
  })
  process.exit(result.status ?? 1)
}

const [command, ...args] = process.argv.slice(2)
if (command === 'plan' && args.length === 1) plan(args[0])
else if (command === 'run' && (args[0] === 'node' || args[0] === 'dom')) run(args[0], args[1])
else {
  console.error(USAGE)
  process.exit(2)
}
