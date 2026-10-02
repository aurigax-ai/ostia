import { describe, expect, it } from 'vitest'
import { DEFAULT_ALLOW_READ } from './sandbox'
import {
  SANDBOX_READ_PRESETS,
  SANDBOX_READ_PRESET_IDS,
  type SandboxReadPreset,
  presetIdOf,
  presetState,
  withPreset,
  withoutPreset,
} from './sandboxPresets'

const CREDENTIAL_PATHS = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.kube',
  '~/.docker',
  '~/.netrc',
  '~/.npmrc',
  '~/.yarnrc.yml',
  '~/.bunfig.toml',
  '~/.pypirc',
  '~/.gitconfig',
  '~/.git-credentials',
  '~/.config/gh',
  '~/.config/git',
  '~/.config/gcloud',
  '~/.config/pnpm',
  '~/.config/pip',
  '~/.config/uv',
  '~/.config/mise',
  '~/.config/go',
  '~/.cargo/credentials.toml',
  '~/.cargo/credentials',
  '~/.local/share/uv/credentials',
  '~/.deno/deployctl',
  '~/.linuxbrew/etc',
  '~/.linuxbrew/var',
  '~/.m2/settings.xml',
  '~/.gradle/gradle.properties',
]

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)
}

const BUN: SandboxReadPreset = { id: 'bun', paths: ['~/.bun'] }
const UV: SandboxReadPreset = {
  id: 'uv',
  paths: ['~/.local/share/uv/tools', '~/.local/share/uv/python'],
}

describe('SANDBOX_READ_PRESETS', () => {
  it('has one preset per id, each naming folders under the home folder', () => {
    expect(SANDBOX_READ_PRESETS.map((preset) => preset.id)).toEqual([...SANDBOX_READ_PRESET_IDS])
    for (const preset of SANDBOX_READ_PRESETS) {
      expect(preset.paths.length).toBeGreaterThan(0)
      for (const path of preset.paths) expect(path).toMatch(/^~\/[^/]/)
    }
  })

  it('never opens a folder that holds, or sits inside, a place tools keep credentials', () => {
    const opened = SANDBOX_READ_PRESETS.flatMap((preset) => [
      ...preset.paths,
      ...(preset.files ?? []),
    ])
    for (const path of opened) {
      expect(CREDENTIAL_PATHS.filter((secret) => overlaps(path, secret))).toEqual([])
    }
  })

  it('opens only the binaries of Deno and the tool and interpreter folders of uv', () => {
    const paths = (id: string): string[] =>
      SANDBOX_READ_PRESETS.find((preset) => preset.id === id)?.paths ?? []
    expect(paths('deno')).toEqual(['~/.deno/bin'])
    expect(paths('uv')).not.toContain('~/.local/share/uv')
    expect(paths('versionManagers')).not.toContain('~/.config/mise')
  })

  it('keeps no path in two presets, so a list entry has one name', () => {
    const all = SANDBOX_READ_PRESETS.flatMap((preset) => [...preset.paths, ...(preset.files ?? [])])
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('DEFAULT_ALLOW_READ', () => {
  it('opens the folders the links in ~/.local/bin point into, and no credential folder beyond ~/.cargo', () => {
    expect(DEFAULT_ALLOW_READ).toEqual(
      expect.arrayContaining([
        '~/.local/bin',
        '~/.local/share/claude',
        '~/.local/share/uv/tools',
        '~/.local/share/uv/python',
        '~/.local/share/pipx',
      ]),
    )
    const risky = DEFAULT_ALLOW_READ.filter((path) =>
      CREDENTIAL_PATHS.some((secret) => overlaps(path, secret)),
    )
    expect(risky).toEqual(['~/.cargo'])
  })
})

describe('presetState', () => {
  it('is on only when every folder of the preset is in the list', () => {
    expect(presetState(UV, [], [])).toBe('off')
    expect(presetState(UV, ['~/.local/share/uv/tools'], [])).toBe('off')
    expect(presetState(UV, ['~/.local/share/uv/tools', '~/.local/share/uv/python'], [])).toBe('on')
  })

  it('is inherited when the defaults already hold every folder, and on when the two lists share them', () => {
    expect(presetState(UV, [], UV.paths)).toBe('inherited')
    expect(presetState(UV, ['~/.local/share/uv/python'], ['~/.local/share/uv/tools'])).toBe('on')
  })
})

describe('withPreset / withoutPreset', () => {
  it('adds only the folders that are in neither list, after the existing entries', () => {
    expect(withPreset(['~/notes'], UV, ['~/.local/share/uv/tools'])).toEqual([
      '~/notes',
      '~/.local/share/uv/python',
    ])
    expect(withPreset(['~/.bun'], BUN, [])).toEqual(['~/.bun'])
  })

  it('removes the preset’s folders and nothing else', () => {
    expect(withoutPreset(['~/notes', '~/.bun', '~/.bun-extra'], BUN)).toEqual([
      '~/notes',
      '~/.bun-extra',
    ])
  })
})

describe('presetIdOf', () => {
  it('names the preset a list entry came from, and nothing for a hand-typed path', () => {
    expect(presetIdOf('~/.bun', SANDBOX_READ_PRESETS)).toBe('bun')
    expect(presetIdOf('~/go', SANDBOX_READ_PRESETS)).toBe('go')
    expect(presetIdOf('~/.tool-versions', SANDBOX_READ_PRESETS)).toBe('versionManagers')
    expect(presetIdOf('~/notes', SANDBOX_READ_PRESETS)).toBeUndefined()
  })
})
