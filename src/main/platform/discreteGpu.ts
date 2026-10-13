import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const GPU_ENV_KEYS: readonly string[] = [
  'DRI_PRIME',
  '__NV_PRIME_RENDER_OFFLOAD',
  '__GLX_VENDOR_LIBRARY_NAME',
  '__VK_LAYER_NV_optimus',
  'VK_LOADER_DRIVERS_SELECT',
]

export const GPU_RESTORE_ENV = 'OSTIA_GPU_RESTORE'

const MAX_VALUE_LENGTH = 256

export interface SwitcherooGpu {
  name: string
  isDefault: boolean
  discrete: boolean
  environment: Record<string, string>
}

type Restore = Record<string, string | null>

function variant(raw: unknown, type: string): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined
  const v = raw as { type?: unknown; data?: unknown }
  return v.type === type ? v.data : undefined
}

function validValue(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_VALUE_LENGTH && !value.includes('\0')
}

export function parseGpuEnvironment(raw: unknown): Record<string, string> | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length % 2 !== 0) return null
  const env: Record<string, string> = {}
  for (let i = 0; i < raw.length; i += 2) {
    const [key, value] = [raw[i], raw[i + 1]]
    if (typeof key !== 'string' || !GPU_ENV_KEYS.includes(key) || !validValue(value)) return null
    env[key] = value
  }
  return env
}

export function parseSwitcherooGpus(json: string): SwitcherooGpu[] | null {
  let reply: unknown
  try {
    reply = JSON.parse(json)
  } catch {
    return null
  }
  const entries = variant(reply, 'aa{sv}')
  if (!Array.isArray(entries)) return null
  const gpus: SwitcherooGpu[] = []
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue
    const fields = entry as Record<string, unknown>
    const name = variant(fields.Name, 's')
    const environment = parseGpuEnvironment(variant(fields.Environment, 'as'))
    if (typeof name !== 'string' || !environment) continue
    gpus.push({
      name,
      isDefault: variant(fields.Default, 'b') === true,
      discrete: variant(fields.Discrete, 'b') === true,
      environment,
    })
  }
  return gpus
}

export function discreteGpu(gpus: SwitcherooGpu[] | null): SwitcherooGpu | null {
  return gpus?.find((gpu) => gpu.discrete && !gpu.isDefault) ?? null
}

const SWITCHEROO_ARGS = [
  '--system',
  '--json=short',
  'get-property',
  'net.hadess.SwitcherooControl',
  '/net/hadess/SwitcherooControl',
  'net.hadess.SwitcherooControl',
  'GPUs',
]

const SWITCHEROO_TIMEOUT_MS = 2000

export function readSwitcherooGpus(): SwitcherooGpu[] | null {
  try {
    return parseSwitcherooGpus(
      execFileSync('busctl', SWITCHEROO_ARGS, {
        encoding: 'utf8',
        timeout: SWITCHEROO_TIMEOUT_MS,
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    )
  } catch {
    return null
  }
}

export function querySwitcherooGpus(): Promise<SwitcherooGpu[] | null> {
  return new Promise((resolve) => {
    execFile(
      'busctl',
      SWITCHEROO_ARGS,
      { encoding: 'utf8', timeout: SWITCHEROO_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : parseSwitcherooGpus(stdout)),
    )
  })
}

export function gpuRelaunchEnv(
  env: NodeJS.ProcessEnv,
  gpu: SwitcherooGpu,
): Record<string, string> | null {
  if (env[GPU_RESTORE_ENV] !== undefined) return null
  const keys = Object.keys(gpu.environment)
  if (keys.every((key) => env[key] === gpu.environment[key])) return null
  const restore: Restore = {}
  for (const key of keys) restore[key] = env[key] ?? null
  return { ...gpu.environment, [GPU_RESTORE_ENV]: JSON.stringify(restore) }
}

function parseRestore(raw: string | undefined): Restore | null {
  if (raw === undefined) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const restore: Restore = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!GPU_ENV_KEYS.includes(key) || !(value === null || validValue(value))) return null
      restore[key] = value
    }
    return restore
  } catch {
    return null
  }
}

export function withoutGpuLaunchEnv<T extends NodeJS.ProcessEnv>(env: T): T {
  if (env[GPU_RESTORE_ENV] === undefined) return env
  const out: NodeJS.ProcessEnv = { ...env }
  delete out[GPU_RESTORE_ENV]
  for (const [key, value] of Object.entries(parseRestore(env[GPU_RESTORE_ENV]) ?? {})) {
    if (value === null) delete out[key]
    else out[key] = value
  }
  return out as T
}

export function restoreGpuLaunchEnv(env: NodeJS.ProcessEnv): void {
  const restored = withoutGpuLaunchEnv(env)
  for (const key of [GPU_RESTORE_ENV, ...GPU_ENV_KEYS]) {
    if (restored[key] === undefined) delete env[key]
    else env[key] = restored[key]
  }
}

export function renderNodeOf(
  driPrime: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string | null {
  const m = /^pci-([0-9a-f]{4})_([0-9a-f]{2})_([0-9a-f]{2})_([0-7])$/.exec(driPrime ?? '')
  if (!m) return null
  const path = `/dev/dri/by-path/pci-${m[1]}:${m[2]}:${m[3]}.${m[4]}-render`
  return exists(path) ? path : null
}

export type GpuStartPlan =
  | { kind: 'relaunch'; env: Record<string, string> }
  | { kind: 'stay'; renderNode: string | null }

export function gpuStartPlan(env: NodeJS.ProcessEnv, gpu: SwitcherooGpu): GpuStartPlan {
  const relaunch = gpuRelaunchEnv(env, gpu)
  if (relaunch) return { kind: 'relaunch', env: relaunch }
  return { kind: 'stay', renderNode: renderNodeOf(gpu.environment.DRI_PRIME) }
}
