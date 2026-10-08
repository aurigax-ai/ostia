import { pathToFileURL } from 'node:url'
import { githubRequestFrom } from './github.mjs'

export const CHECK_NAME = 'ci-result'
export const QUEUE_BRANCH_PREFIX = 'gh-readonly-queue/main/'
export const WORKFLOW_PATH = '.github/workflows/ci.yml'
export const APP = 'github-actions'
const SHA = /^[0-9a-f]{40}$/
const USAGE = 'usage: node scripts/mergeQueueVerified.mjs <commit-sha>'

export function passingCheckRuns(sha, checkRuns) {
  return (checkRuns ?? []).filter(
    (run) =>
      run?.name === CHECK_NAME &&
      run.head_sha === sha &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.app?.slug === APP &&
      Number.isInteger(run.check_suite?.id),
  )
}

export async function passingCiResultRuns(sha, request) {
  const runs = await request(
    `commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest&per_page=100`,
  )
  return passingCheckRuns(sha, runs?.check_runs)
}

export function fromMergeQueue(sha, suite, workflowRuns) {
  if (suite?.head_sha !== sha || suite.app?.slug !== APP) return false
  if (typeof suite.head_branch !== 'string') return false
  if (!suite.head_branch.startsWith(QUEUE_BRANCH_PREFIX)) return false
  return (workflowRuns ?? []).some(
    (run) =>
      run?.head_sha === sha &&
      run.event === 'merge_group' &&
      run.path === WORKFLOW_PATH &&
      run.head_branch === suite.head_branch,
  )
}

export async function mergeQueueVerified(sha, request) {
  if (typeof sha !== 'string' || !SHA.test(sha)) {
    return { verified: false, reason: `not a full commit sha: ${JSON.stringify(sha)}` }
  }
  try {
    const passing = await passingCiResultRuns(sha, request)
    if (passing.length === 0) {
      return { verified: false, reason: `no successful ${CHECK_NAME} check run for ${sha}` }
    }
    for (const run of passing) {
      const suiteId = run.check_suite.id
      const suite = await request(`check-suites/${suiteId}`)
      const workflow = await request(`actions/runs?check_suite_id=${suiteId}&per_page=100`)
      if (fromMergeQueue(sha, suite, workflow?.workflow_runs)) {
        return {
          verified: true,
          reason: `${CHECK_NAME} passed for ${sha} in the merge queue (${suite.head_branch}): ${run.html_url ?? run.details_url ?? `check run ${run.id}`}`,
        }
      }
    }
    return {
      verified: false,
      reason: `${CHECK_NAME} passed for ${sha}, but not in a merge queue run on ${QUEUE_BRANCH_PREFIX}*`,
    }
  } catch (error) {
    return {
      verified: false,
      reason: `cannot tell whether the merge queue checked ${sha}: ${error?.message ?? error}`,
    }
  }
}

async function main(args, env) {
  if (args.length !== 1) {
    console.error(USAGE)
    console.log('false')
    return
  }
  let result
  try {
    result = await mergeQueueVerified(args[0], githubRequestFrom(env))
  } catch (error) {
    result = { verified: false, reason: error?.message ?? String(error) }
  }
  console.error(result.reason)
  console.log(result.verified ? 'true' : 'false')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2), process.env)
}
