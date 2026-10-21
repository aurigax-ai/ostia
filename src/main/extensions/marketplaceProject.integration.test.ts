import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { MARKETPLACE_MANIFEST_FILE } from '@aurigax-ai/ostia-extension-sdk/manifest/marketplaceManifest'
import { describe, expect, it } from 'vitest'
import { dependencyRange } from '../../../scripts/catalog.mjs'

const repoRoot = resolve(__dirname, '../../..')
const sdkPackage = join(repoRoot, 'out/sdk')
const sdkCli = join(sdkPackage, 'dist/cli.cjs')

describe('the marketplace project, built the way its own repository builds it', () => {
  const marketplace = join(repoRoot, 'out/marketplace')
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sources(join(dir, entry.name)) : [join(dir, entry.name)],
    )

  it('holds the source, tests and tool fixtures of its extensions, unchanged', () => {
    for (const file of [
      'src/extensions/trellis/main.ts',
      'src/extensions/keeper/service.test.ts',
      'src/extensions/model-runtime/ostia.json',
      'test/fixtures/tools/bin/trellis',
    ]) {
      expect(readFileSync(join(marketplace, file), 'utf8'), file).toBe(
        readFileSync(join(repoRoot, file), 'utf8'),
      )
    }
  })

  it('imports nothing by a path that leaves an extension folder', () => {
    const escaping = sources(join(marketplace, 'src')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/from '(\.\.\/[^']*)'/g)].map(
        (match) => `${file}: ${match[1]}`,
      ),
    )
    expect(escaping).toEqual([])
  })

  it('depends on the SDK of this version and on nothing unversioned', () => {
    const pkg = JSON.parse(readFileSync(join(marketplace, 'package.json'), 'utf8'))
    const app = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    expect(pkg.devDependencies['@aurigax-ai/ostia-extension-sdk']).toBe(app.version)
    expect(Object.values(pkg.devDependencies).every((range) => typeof range === 'string')).toBe(
      true,
    )
  })

  it('typechecks against the published types', () => {
    const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')
    const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', marketplace], {
      encoding: 'utf8',
    })
    expect(res.stdout + res.stderr).toBe('')
    expect(res.status).toBe(0)
  }, 60_000)

  it('passes the packaged validate command with every extension built, the unlisted ones counted apart', () => {
    const res = spawnSync(process.execPath, [sdkCli, 'validate', marketplace], {
      encoding: 'utf8',
    })
    const listed = JSON.parse(
      readFileSync(join(repoRoot, 'marketplace', MARKETPLACE_MANIFEST_FILE), 'utf8'),
    ) as { extensions: string[]; unlisted: unknown[] }
    expect(res.stdout.trim()).toBe(
      `ok: marketplace "Ostia extensions" with ${listed.extensions.length} extension(s), ${listed.unlisted.length} unlisted`,
    )
    expect(res.status).toBe(0)
  })

  it('ships each extension’s catalogs, and its panel files when it has a panel', () => {
    const built = join(marketplace, 'extensions')
    for (const id of readdirSync(built)) {
      const manifest = JSON.parse(readFileSync(join(built, id, 'ostia.json'), 'utf8'))
      for (const tag of manifest.locales ?? []) {
        expect(existsSync(join(built, id, 'locales', `${tag}.json`)), `${id} ${tag}`).toBe(true)
      }
    }
    for (const file of ['panel.html', 'panel.css', 'panel.js', 'base.css', 'locales/en.json']) {
      expect(existsSync(join(built, 'trellis', file)), file).toBe(true)
    }
    expect(readFileSync(join(built, 'trellis/base.css'), 'utf8')).toBe(
      readFileSync(join(sdkPackage, 'panel.css'), 'utf8'),
    )
  })

  it('ships every file of the agent skills an extension declares, as the source has them', () => {
    const built = join(marketplace, 'extensions')
    const shipped = readdirSync(built).flatMap((id) => {
      const manifest = JSON.parse(readFileSync(join(built, id, 'ostia.json'), 'utf8'))
      return (manifest.contributes?.agentSkills ?? []).flatMap(
        (skill: { path: string; files?: string[] }) =>
          ['SKILL.md', ...(skill.files ?? [])].map((file) => join(id, skill.path, file)),
      )
    })
    const declared = readdirSync(built).flatMap((id) => {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, 'src/extensions', id, 'ostia.json'), 'utf8'),
      )
      return (manifest.contributes?.agentSkills ?? []).flatMap(
        (skill: { path: string; files?: string[] }) =>
          ['SKILL.md', ...(skill.files ?? [])].map((file) => join(id, skill.path, file)),
      )
    })
    expect(shipped).toEqual(declared)
    expect(shipped).toContain('trellis/skills/card/SKILL.md')
    for (const file of shipped) {
      expect(readFileSync(join(built, file), 'utf8'), file).toBe(
        readFileSync(join(repoRoot, 'src/extensions', file), 'utf8'),
      )
    }
  })

  it('ships the server every language extension runs from its own folder, as its package has it', () => {
    const built = join(marketplace, 'extensions')
    const servers = readdirSync(built).flatMap((id) => {
      const manifest = JSON.parse(readFileSync(join(built, id, 'ostia.json'), 'utf8'))
      return (manifest.contributes?.languageServers ?? [])
        .filter((server: { run: { node?: string } }) => server.run.node)
        .map((server: { run: { node: string } }) => join(id, server.run.node))
    })
    expect(servers).toHaveLength(4)
    for (const script of servers) expect(existsSync(join(built, script)), script).toBe(true)
    const vendored = 'lsp-typescript/server/typescript-language-server/lib/cli.mjs'
    expect(readFileSync(join(built, vendored), 'utf8')).toBe(
      readFileSync(join(repoRoot, 'node_modules/typescript-language-server/lib/cli.mjs'), 'utf8'),
    )
  })

  it('declares every package it vendors or bundles as a dependency of its own', () => {
    const pkg = JSON.parse(readFileSync(join(marketplace, 'package.json'), 'utf8'))
    for (const name of [
      'bash-language-server',
      'pyright',
      'typescript',
      'typescript-language-server',
      'yaml-language-server',
    ]) {
      expect(pkg.devDependencies[name], name).toBe(dependencyRange(name))
      expect(pkg.devDependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/)
    }
    for (const name of ['@phosphor-icons/core', 'mdast-util-from-markdown']) {
      expect(pkg.devDependencies[name], name).toBeTruthy()
    }
  })

  it('keeps a vendored node_modules folder in its repository', () => {
    expect(readFileSync(join(marketplace, '.gitignore'), 'utf8').split('\n')).toContain(
      '/node_modules',
    )
  })
})
