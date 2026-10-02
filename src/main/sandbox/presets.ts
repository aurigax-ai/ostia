import { delimiter, isAbsolute, relative } from 'node:path'
import {
  SANDBOX_READ_PRESETS,
  type SandboxReadPreset,
  type SandboxReadPresetId,
} from '../../shared/sandboxPresets'
import { type SandboxPathEnv, checkSandboxPath } from './pathChecks'
import { within } from './srtConfig'

type ProcessEnv = Record<string, string | undefined>

function underHome(path: string | undefined, home: string): string[] {
  if (!path || !isAbsolute(path) || !within(path, home) || path === home) return []
  return [`~/${relative(home, path)}`]
}

const ENV_PATHS: Partial<Record<SandboxReadPresetId, (env: ProcessEnv, home: string) => string[]>> =
  {
    go: (env, home) => [
      ...underHome(env.GOPATH?.split(delimiter)[0], home),
      ...underHome(env.GOROOT, home),
    ],
  }

export function availableReadPresets(
  env: SandboxPathEnv,
  processEnv: ProcessEnv = process.env,
): SandboxReadPreset[] {
  const accepted = (paths: readonly string[]): string[] =>
    [...new Set(paths)].filter((path) => checkSandboxPath('allowRead', path, env).ok)
  return SANDBOX_READ_PRESETS.map((preset) => {
    const folders = accepted([
      ...preset.paths,
      ...(ENV_PATHS[preset.id]?.(processEnv, env.home) ?? []),
    ])
    const paths = folders.length > 0 ? [...folders, ...accepted(preset.files ?? [])] : []
    return { id: preset.id, paths }
  }).filter((preset) => preset.paths.length > 0)
}
