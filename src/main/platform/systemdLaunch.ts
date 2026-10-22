import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { accessSync, constants } from 'node:fs'
import { readNoNewPrivs } from './noNewPrivs'
import { findOnPath } from './pathLookup'

const SERVICE_ENV_KEYS: readonly string[] = [
  'INVOCATION_ID',
  'JOURNAL_STREAM',
  'NOTIFY_SOCKET',
  'MAINPID',
  'MANAGERPID',
  'SYSTEMD_EXEC_PID',
]

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const START_TIMEOUT_MS = 5000

export interface SystemdLaunchInput {
  platform: NodeJS.Platform
  noNewPrivs: boolean
  systemdRun: string | null
  tail: string | null
  exe: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  unit: string
  waitForPid?: number
}

export interface SystemdLaunch {
  file: string
  args: string[]
}

export function systemdLaunchPlan(input: SystemdLaunchInput): SystemdLaunch | null {
  if (input.platform !== 'linux' || !input.noNewPrivs || !input.systemdRun) return null
  if (input.waitForPid !== undefined && !input.tail) return null
  const setenv = Object.entries(input.env)
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && ENV_NAME.test(entry[0]) && !SERVICE_ENV_KEYS.includes(entry[0]),
    )
    .map(([name, value]) => `--setenv=${name}=${value}`)
  const wait =
    input.waitForPid === undefined
      ? []
      : [`--property=ExecStartPre=${input.tail} --pid=${input.waitForPid} -f /dev/null`]
  return {
    file: input.systemdRun,
    args: [
      '--user',
      '--quiet',
      '--collect',
      '--no-block',
      `--unit=${input.unit}`,
      `--working-directory=${input.cwd}`,
      '--property=KillMode=process',
      ...wait,
      ...setenv,
      '--',
      input.exe,
      ...input.args,
    ],
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function launchThroughSystemd(opts: {
  exe: string
  args: readonly string[]
  env: NodeJS.ProcessEnv
  waitForPid?: number
}): boolean {
  const pathEnv = process.env.PATH ?? ''
  const plan = systemdLaunchPlan({
    platform: process.platform,
    noNewPrivs: readNoNewPrivs(),
    systemdRun: findOnPath('systemd-run', pathEnv, isExecutable),
    tail: findOnPath('tail', pathEnv, isExecutable),
    cwd: process.cwd(),
    unit: `ostia-${randomBytes(6).toString('hex')}`,
    ...opts,
  })
  if (!plan) return false
  try {
    execFileSync(plan.file, plan.args, { stdio: 'ignore', timeout: START_TIMEOUT_MS })
    return true
  } catch {
    return false
  }
}
