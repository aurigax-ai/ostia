export const SANDBOX_READ_PRESET_IDS = [
  'claude',
  'bun',
  'deno',
  'go',
  'pyenv',
  'uv',
  'volta',
  'nodeVersions',
  'pnpm',
  'sdkman',
  'versionManagers',
  'homebrew',
] as const

export type SandboxReadPresetId = (typeof SANDBOX_READ_PRESET_IDS)[number]

export interface SandboxReadPreset {
  id: SandboxReadPresetId
  paths: string[]
}

export interface SandboxReadPresetSpec extends SandboxReadPreset {
  files?: string[]
}

export const SANDBOX_READ_PRESETS: readonly SandboxReadPresetSpec[] = [
  { id: 'claude', paths: ['~/.local/share/claude'] },
  { id: 'bun', paths: ['~/.bun'] },
  { id: 'deno', paths: ['~/.deno/bin'] },
  { id: 'go', paths: ['~/go', '~/sdk'] },
  { id: 'pyenv', paths: ['~/.pyenv'] },
  {
    id: 'uv',
    paths: [
      '~/.local/share/uv/tools',
      '~/.local/share/uv/python',
      '~/.local/share/pipx',
      '~/.local/pipx',
    ],
  },
  { id: 'volta', paths: ['~/.volta'] },
  {
    id: 'nodeVersions',
    paths: [
      '~/.local/share/fnm',
      '~/Library/Application Support/fnm',
      '~/.fnm',
      '~/.nvm',
      '~/.config/nvm',
    ],
  },
  { id: 'pnpm', paths: ['~/.local/share/pnpm', '~/Library/pnpm'] },
  { id: 'sdkman', paths: ['~/.sdkman'] },
  {
    id: 'versionManagers',
    paths: ['~/.asdf', '~/.local/share/mise', '~/.local/state/mise'],
    files: ['~/.asdfrc', '~/.tool-versions'],
  },
  {
    id: 'homebrew',
    paths: [
      '~/.linuxbrew/bin',
      '~/.linuxbrew/sbin',
      '~/.linuxbrew/Cellar',
      '~/.linuxbrew/opt',
      '~/.linuxbrew/lib',
      '~/.linuxbrew/libexec',
      '~/.linuxbrew/share',
      '~/.linuxbrew/include',
      '~/.linuxbrew/Homebrew',
    ],
  },
]

export type SandboxPresetState = 'on' | 'inherited' | 'off'

export function presetState(
  preset: SandboxReadPreset,
  own: readonly string[],
  inherited: readonly string[],
): SandboxPresetState {
  if (preset.paths.every((path) => inherited.includes(path))) return 'inherited'
  return preset.paths.every((path) => own.includes(path) || inherited.includes(path)) ? 'on' : 'off'
}

export function withPreset(
  own: readonly string[],
  preset: SandboxReadPreset,
  inherited: readonly string[],
): string[] {
  const added = preset.paths.filter((path) => !own.includes(path) && !inherited.includes(path))
  return [...own, ...added]
}

export function withoutPreset(own: readonly string[], preset: SandboxReadPreset): string[] {
  return own.filter((path) => !preset.paths.includes(path))
}

export function presetIdOf(
  path: string,
  presets: readonly SandboxReadPresetSpec[],
): SandboxReadPresetId | undefined {
  return presets.find((preset) => preset.paths.includes(path) || preset.files?.includes(path))?.id
}
