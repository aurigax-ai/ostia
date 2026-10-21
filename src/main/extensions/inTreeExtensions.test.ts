import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { EXTENSION_API_VERSION } from '@aurigax-ai/ostia-extension-sdk/contract/extensionApi'
import { overlaySettings } from '@aurigax-ai/ostia-extension-sdk/contract/languageServerConfig'
import {
  agentSkillProblems,
  loadAgentSkill,
} from '@aurigax-ai/ostia-extension-sdk/manifest/agentSkills'
import {
  parseManifest,
  readManifest,
} from '@aurigax-ai/ostia-extension-sdk/manifest/extensionManifest'
import { localeProblems } from '@aurigax-ai/ostia-extension-sdk/manifest/localeCatalogs'
import { extensionManifestSchema } from '@aurigax-ai/ostia-extension-sdk/manifest/manifestSchema'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../..')
const extensions = join(repoRoot, 'src/extensions')
const manifestFiles = [
  ...readdirSync(extensions).map((id) => join(extensions, id, 'ostia.json')),
  ...[
    'extensions/echo',
    'extensions-e2e/hello',
    'extensions-agent/agent-kit',
    'extensions-lsp/fake-lang',
    'extensions-lsp/fake-json',
    'extensions-lsp/fake-grammar',
  ].map((dir) => join(repoRoot, 'test/fixtures', dir, 'ostia.json')),
]

describe('the manifests in this repository', () => {
  it('pass the published manifest schema', () => {
    for (const file of manifestFiles) {
      const res = extensionManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      expect(res.success ? null : res.error.message, file).toBeNull()
    }
  })

  it('declare the current API, since each extension here bundles this SDK', () => {
    for (const id of readdirSync(extensions)) {
      const manifest = JSON.parse(readFileSync(join(extensions, id, 'ostia.json'), 'utf8'))
      expect(manifest.api, id).toBe(EXTENSION_API_VERSION)
    }
  })

  it('accepts every built-in and marketplace manifest', () => {
    for (const id of [
      'assistant',
      'completions',
      'csv',
      'images',
      'keeper',
      'keymap-macos',
      'langpack-zh-hant',
      'lsp-bash',
      'lsp-clangd',
      'lsp-gopls',
      'lsp-lua',
      'lsp-marksman',
      'lsp-pyright',
      'lsp-rust-analyzer',
      'lsp-typescript',
      'lsp-yaml',
      'markdown',
      'model-runtime',
      'office',
      'pdf',
      'serial',
      'system',
      'trellis',
      'video',
    ]) {
      const dir = join(extensions, id)
      const raw: unknown = JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8'))
      const res = parseManifest(raw, dir)
      expect(res.ok ? null : res.error, id).toBeNull()
    }
  })

  it('turns on the TypeScript server’s reference counts when the human turns on Reference counts', () => {
    const dir = join(extensions, 'lsp-typescript')
    const res = parseManifest(JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8')), dir)
    if (!res.ok) throw new Error(res.error)
    const server = res.manifest.contributes.languageServers?.[0]
    if (!server) throw new Error('lsp-typescript has no language server')
    expect(
      overlaySettings(server.settings ?? {}, server.settingPaths ?? {}, {
        referencesCodeLens: true,
      }),
    ).toMatchObject({ typescript: { referencesCodeLens: { enabled: true } } })
  })
})

describe('the catalogs shipped in this repository', () => {
  const dirs = [
    ...readdirSync(extensions).map((id) => join(extensions, id)),
    join(repoRoot, 'test/fixtures/extensions-e2e/hello'),
  ]

  it('translate only strings their manifest declares', () => {
    for (const dir of dirs) {
      const res = readManifest(dir)
      if (!res.ok) throw new Error(`${dir}: ${res.error}`)
      expect(localeProblems(dir, res.manifest), dir).toEqual([])
    }
  })

  it('give every extension with human text a Traditional Chinese catalog', () => {
    for (const id of readdirSync(extensions).filter((d) => !d.startsWith('langpack'))) {
      const manifest = JSON.parse(readFileSync(join(extensions, id, 'ostia.json'), 'utf8'))
      expect(manifest.locales, id).toEqual(['zh-Hant'])
    }
  })
})

describe('the trellis extension', () => {
  const dir = join(extensions, 'trellis')
  const parsed = parseManifest(JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8')), dir)
  if (!parsed.ok) throw new Error(parsed.error)
  const manifest = parsed.manifest

  it('declares its card skill and a SessionStart hook under the agent-plugin capability', () => {
    expect(manifest.capabilities).toContain('agent-plugin')
    expect(manifest.contributes.agentSkills).toEqual([
      { name: 'card', path: 'skills/card', files: [] },
    ])
    expect(manifest.contributes.agentHooks).toEqual([
      { event: 'SessionStart', command: 'session-context' },
    ])
    expect(agentSkillProblems(dir, manifest, true)).toEqual([])
  })

  it('ships a skill folder that loads as trellis-card and teaches the card commands', () => {
    const [skill] = manifest.contributes.agentSkills ?? []
    if (!skill) throw new Error('no skill')
    const res = loadAgentSkill(dir, manifest.id, skill, true)
    if (!res.ok) throw new Error(res.error)
    expect(res.skill.id).toBe('trellis-card')
    expect(res.skill.files.map((f) => f.name)).toEqual(['SKILL.md'])
    const text = res.skill.files[0]?.data.toString() ?? ''
    expect(text.split('\n')[1]).toBe('name: trellis-card')
    for (const taught of [
      'trellis card show <ref>',
      'trellis card claim <ref>',
      'trellis card comment <ref> --body',
      'trellis card renew <ref>',
      'trellis card move <ref> <column>',
      'TRELLIS_AGENT',
      'stderr',
      '--body @notes.md',
      'trellis vault new',
      'trellis vault edit',
    ]) {
      expect(text, taught).toContain(taught)
    }
    expect(text).not.toMatch(/ostia|pine/i)
  })
})
