import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { registerControlServer, stopControlServer } from '../main/controlServer'
import { ExtensionHost, registerExtensionMethods } from '../main/extensionHost'
import { parseManifest } from '../main/extensionManifest'
import { ExtensionStore } from '../main/extensionStore'
import { EXTENSION_API_VERSION } from '../shared/extensionApi'
import type { ExtensionCaller } from '../shared/extensions'
import { MARKETPLACE_CODE_PATTERN, MARKETPLACE_MANIFEST_FILE } from '../shared/marketplace'
import type { CommandResult } from '../shared/types'
import { extensionManifestSchema, marketplaceManifestSchema } from './manifestSchema'
import { SDK_CLI_USAGE, newInstallCode, runSdkCli } from './sdkCli'

const repoRoot = resolve(__dirname, '../..')
const sdkPackage = join(repoRoot, 'out/sdk')
const sdkCli = join(sdkPackage, 'dist/cli.cjs')

function manifestFiles(): string[] {
  const extensions = join(repoRoot, 'src/extensions')
  return [
    ...readdirSync(extensions)
      .filter((id) => id !== 'sdk')
      .map((id) => join(extensions, id, 'pine.json')),
    join(repoRoot, 'sdk-package/template/pine.json'),
    join(repoRoot, 'test/fixtures/extensions/echo/pine.json'),
    join(repoRoot, 'test/fixtures/extensions-e2e/hello/pine.json'),
    join(repoRoot, 'test/fixtures/extensions-agent/agent-kit/pine.json'),
    join(repoRoot, 'test/fixtures/extensions-lsp/fake-lang/pine.json'),
    join(repoRoot, 'test/fixtures/extensions-lsp/fake-json/pine.json'),
    join(repoRoot, 'test/fixtures/extensions-lsp/fake-grammar/pine.json'),
  ]
}

describe('manifest schemas', () => {
  it('accept every manifest in the repository', () => {
    for (const file of manifestFiles()) {
      const res = extensionManifestSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')))
      expect(res.success ? null : res.error.message, file).toBeNull()
    }
  })

  it('refuse what the loader refuses', () => {
    const base = { id: 'demo', name: 'Demo', version: '1.0.0', api: '1.0' }
    const pageSettings = { mode: { type: 'string', default: '', description: 'd' } }
    const agentHookCommand = { id: 'on-hook', title: 'Hook', palette: false, stdin: true }
    const bad: Record<string, unknown>[] = [
      { ...base, id: 'Bad Id' },
      { ...base, name: '' },
      { ...base, category: 'games' },
      { ...base, capabilities: ['root'] },
      { ...base, contributes: { commands: [{ id: 'Run It', title: 'Run' }] } },
      { ...base, contributes: { assist: ['everything'] } },
      { ...base, contributes: { languages: [{ id: 'not a tag', label: 'X', path: 'x.json' }] } },
      { ...base, contributes: { languages: [{ id: 'fr', label: 'Français', path: 'fr.yaml' }] } },
      ...[
        { id: 'Cmux' },
        { label: '' },
        { label: 'x'.repeat(41) },
        { path: 'cmux.yaml' },
        { platform: 'win32' },
      ].map((keymap) => ({
        ...base,
        contributes: { keymaps: [{ id: 'cmux', label: 'cmux', path: 'cmux.json', ...keymap }] },
      })),
      {
        ...base,
        contributes: {
          keymaps: Array.from({ length: 9 }, (_, i) => ({
            id: `k${i}`,
            label: 'k',
            path: 'k.json',
          })),
        },
      },
      { ...base, locales: 'zh-Hant' },
      { ...base, locales: ['../zh-Hant'] },
      { ...base, locales: Array.from({ length: 33 }, (_, i) => `zh-T${i}`) },
      {
        ...base,
        contributes: { settings: { k: { type: 'color', default: '', description: 'd' } } },
      },
      ...[{ title: 'Mine', icon: 'rocket' }, { icon: 'kanban' }, { title: 'x'.repeat(81) }].map(
        (settingsPage) => ({
          ...base,
          contributes: { settings: pageSettings, settingsPage },
        }),
      ),
      ...[
        { id: 'Bad Id' },
        { languages: [] },
        { languages: ['Python'] },
        { run: { node: 'main.py' } },
        { run: { node: 'main.js', program: 'main' } },
        { run: { program: '/usr/bin/main' } },
        { run: { program: 'main', args: ['a'.repeat(201)] } },
        { rootMarkers: ['a/b'] },
        { settingPaths: { mode: 'a..b' } },
        ...[
          { url: 'http://github.com/o/r/t.gz' },
          { url: 'https://evil.example/t.gz' },
          { sha256: 'abc' },
          { archive: 'rar' },
          { executable: '../t' },
        ].map((asset) => ({
          run: {
            download: {
              program: 'demo',
              version: '1.0.0',
              assets: {
                'linux-x64': {
                  url: 'https://github.com/o/r/releases/download/1/t.gz',
                  sha256: 'a'.repeat(64),
                  archive: 'gz',
                  executable: 't',
                  ...asset,
                },
              },
            },
          },
        })),
        { run: { download: { program: 'demo', version: 'latest', assets: {} } } },
        { run: { goInstall: { module: '-x', version: 'v1.0.0', binary: 'demo' } } },
        { run: { goInstall: { module: 'example.org/x/demo', version: 'latest', binary: 'demo' } } },
        { run: { goInstall: { module: 'example.org/x/demo', version: 'v1.0.0', binary: 'a/b' } } },
      ].map((server) => ({
        ...base,
        capabilities: ['language-server'],
        contributes: {
          settings: { mode: { type: 'string', default: '', description: 'd' } },
          languageServers: [
            {
              id: 'demo',
              name: 'Demo',
              languages: ['python'],
              run: { program: 'demo' },
              ...server,
            },
          ],
        },
      })),
      ...[
        { id: 'Bad Id' },
        { id: 'typescript' },
        { name: '' },
        { extensions: ['gleam'] },
        { filenames: ['a/b'] },
        { grammar: 'grammar.js' },
        { configuration: { lineComment: 'x'.repeat(11) } },
        { configuration: { brackets: [['{']] } },
      ].map((language) => ({
        ...base,
        contributes: {
          editorLanguages: [
            {
              id: 'gleam',
              name: 'Gleam',
              extensions: ['.gleam'],
              grammar: 'gleam.monarch.json',
              ...language,
            },
          ],
        },
      })),
      ...[
        { agentSkills: [{ name: 'Bad Name', path: 'skills/a' }] },
        { agentSkills: [{ name: 'a', path: 'skills/a', files: ['run.sh'] }] },
        { agentSkills: [{ name: 'a', path: 'skills/a', files: ['SKILL.md'] }] },
        { agentHooks: [{ event: 'Startup', command: 'on-hook' }] },
        { agentHooks: [{ event: 'Stop', command: 'rm -rf /' }] },
      ].map((agent) => ({
        ...base,
        capabilities: ['agent-plugin'],
        main: 'main.js',
        contributes: { commands: [agentHookCommand], ...agent },
      })),
    ]
    for (const manifest of bad) {
      expect(parseManifest(manifest, '/ext').ok, JSON.stringify(manifest)).toBe(false)
      expect(extensionManifestSchema.safeParse(manifest).success, JSON.stringify(manifest)).toBe(
        false,
      )
    }
    expect(parseManifest(base, '/ext').ok).toBe(true)
    expect(extensionManifestSchema.safeParse(base).success).toBe(true)
    const paged = {
      ...base,
      contributes: { settings: pageSettings, settingsPage: { title: 'Mine', icon: 'kanban' } },
    }
    expect(parseManifest(paged, '/ext').ok).toBe(true)
    expect(extensionManifestSchema.safeParse(paged).success).toBe(true)
    const agent = {
      ...base,
      capabilities: ['agent-plugin'],
      main: 'main.js',
      contributes: {
        commands: [agentHookCommand],
        agentSkills: [{ name: 'review', path: 'skills/review', files: ['checklist.md'] }],
        agentHooks: [{ event: 'SessionStart', command: 'on-hook' }],
      },
    }
    expect(parseManifest(agent, '/ext').ok).toBe(true)
    expect(extensionManifestSchema.safeParse(agent).success).toBe(true)
    const keyed = {
      ...base,
      contributes: {
        keymaps: [{ id: 'cmux', label: 'macOS (cmux)', path: 'cmux.json', platform: 'darwin' }],
      },
    }
    expect(parseManifest(keyed, '/ext').ok).toBe(true)
    expect(extensionManifestSchema.safeParse(keyed).success).toBe(true)
    const translated = { ...base, locales: ['zh-Hant', 'fr'] }
    expect(parseManifest(translated, '/ext').ok).toBe(true)
    expect(extensionManifestSchema.safeParse(translated).success).toBe(true)
  })

  it('describe a marketplace file', () => {
    expect(marketplaceManifestSchema.safeParse({ name: 'Mine', extensions: ['a'] }).success).toBe(
      true,
    )
    expect(marketplaceManifestSchema.safeParse({ extensions: ['a'] }).success).toBe(false)
    expect(
      marketplaceManifestSchema.safeParse({
        name: 'Mine',
        extensions: [],
        unlisted: [{ path: 'a', code: 'guessable' }],
      }).success,
    ).toBe(false)
    expect(marketplaceManifestSchema.safeParse({ name: 'Mine', extensions: 'a' }).success).toBe(
      false,
    )
  })

  it('ship in the package as JSON Schema with the same enumerations', () => {
    const schema = JSON.parse(
      readFileSync(join(sdkPackage, 'schemas/pine.schema.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, { enum?: string[] }> }
    expect(schema.required).toEqual(['id', 'name', 'version', 'api'])
    expect(schema.properties.category?.enum).toContain('scm')
  })
})

describe('extension API version', () => {
  it('is bumped whenever the published contract changes', () => {
    const built = JSON.parse(readFileSync(join(sdkPackage, 'api.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(repoRoot, 'sdk-package/api-lock.json'), 'utf8'))
    expect(lock.version, 'run pnpm api:bump <minor|major>').toBe(EXTENSION_API_VERSION)
    expect(
      built.digest,
      'the SDK types or manifest schemas changed: run pnpm api:bump <minor|major>',
    ).toBe(lock.digest)
  })

  it('ships the TypeScript it was built from, unchanged', () => {
    for (const file of [
      'src/extensions/sdk/index.ts',
      'src/extensions/sdk/assist/service.ts',
      'src/shared/extensions.ts',
      'src/main/extensionManifest.ts',
      'src/cli/manifestSchema.ts',
    ]) {
      expect(readFileSync(join(sdkPackage, file), 'utf8'), file).toBe(
        readFileSync(join(repoRoot, file), 'utf8'),
      )
    }
  })

  it('is what every extension built from this tree declares, since each bundles this SDK', () => {
    for (const file of manifestFiles().filter((f) => !f.includes('/test/fixtures/'))) {
      expect(JSON.parse(readFileSync(file, 'utf8')).api, file).toBe(EXTENSION_API_VERSION)
    }
  })

  it('is published in the package for authors and tools', () => {
    const pkg = JSON.parse(readFileSync(join(sdkPackage, 'package.json'), 'utf8'))
    expect(pkg.pineExtensionApi).toBe(EXTENSION_API_VERSION)
  })

  it('declares the pine-extension command in the form npm keeps when it publishes', () => {
    const pkg = JSON.parse(readFileSync(join(sdkPackage, 'package.json'), 'utf8'))
    expect(pkg.bin).toEqual({ 'pine-extension': 'dist/cli.cjs' })
    expect(existsSync(join(sdkPackage, pkg.bin['pine-extension']))).toBe(true)
  })
})

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
      'src/extensions/model-runtime/pine.json',
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
    expect(pkg.devDependencies['@aurigax-ai/pine-extension-sdk']).toBe(app.version)
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

  it('passes the packaged validate command with every extension built, two of them unlisted', () => {
    const res = spawnSync(process.execPath, [sdkCli, 'validate', marketplace], {
      encoding: 'utf8',
    })
    expect(res.stdout.trim()).toBe(
      'ok: marketplace "Pine extensions" with 10 extension(s), 2 unlisted',
    )
    expect(res.status).toBe(0)
  })

  it('ships each extension’s catalogs, and its panel files when it has a panel', () => {
    const built = join(marketplace, 'extensions')
    for (const id of readdirSync(built)) {
      const manifest = JSON.parse(readFileSync(join(built, id, 'pine.json'), 'utf8'))
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
      const manifest = JSON.parse(readFileSync(join(built, id, 'pine.json'), 'utf8'))
      return (manifest.contributes?.agentSkills ?? []).flatMap(
        (skill: { path: string; files?: string[] }) =>
          ['SKILL.md', ...(skill.files ?? [])].map((file) => join(id, skill.path, file)),
      )
    })
    expect(shipped).toEqual(['trellis/skills/card/SKILL.md'])
    for (const file of shipped) {
      expect(readFileSync(join(built, file), 'utf8'), file).toBe(
        readFileSync(join(repoRoot, 'src/extensions', file), 'utf8'),
      )
    }
  })

  it('ships the server every language extension runs from its own folder, as its package has it', () => {
    const built = join(marketplace, 'extensions')
    const servers = readdirSync(built).flatMap((id) => {
      const manifest = JSON.parse(readFileSync(join(built, id, 'pine.json'), 'utf8'))
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
    const app = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
    for (const name of [
      'bash-language-server',
      'pyright',
      'typescript',
      'typescript-language-server',
      'yaml-language-server',
    ]) {
      expect(pkg.devDependencies[name], name).toBe(app.devDependencies[name])
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

describe('the SDK package, used the way an extension author uses it', () => {
  let project: string
  let built: string

  const linkDependency = (name: string, target: string): void => {
    const path = join(project, 'node_modules', name)
    mkdirSync(resolve(path, '..'), { recursive: true })
    symlinkSync(target, path, 'dir')
  }

  beforeAll(() => {
    project = mkdtempSync(join(tmpdir(), 'pine-sdk-consumer-'))
    execFileSync(process.execPath, [sdkCli, 'create', 'hello', project], { stdio: 'ignore' })
    linkDependency('@aurigax-ai/pine-extension-sdk', sdkPackage)
    for (const name of ['esbuild', '@types/node']) {
      linkDependency(name, join(repoRoot, 'node_modules', name))
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: project, stdio: 'ignore' })
    built = join(project, 'dist/hello')
  }, 60_000)

  afterAll(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('creates a project named after the id, ready for git and for the build', () => {
    const parent = mkdtempSync(join(tmpdir(), 'pine-sdk-create-'))
    try {
      const res = spawnSync(process.execPath, [sdkCli, 'create', 'weather-report'], {
        cwd: parent,
        encoding: 'utf8',
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('created the Weather Report extension in weather-report')
      const made = join(parent, 'weather-report')
      const manifest = JSON.parse(readFileSync(join(made, 'pine.json'), 'utf8'))
      expect(parseManifest(manifest, made).ok).toBe(true)
      expect(manifest).toMatchObject({ id: 'weather-report', name: 'Weather Report' })
      expect(manifest.contributes.commands[0]).toMatchObject({
        title: 'Weather Report: Greet',
        category: 'Weather Report',
      })
      const pkg = JSON.parse(readFileSync(join(made, 'package.json'), 'utf8'))
      expect(pkg.name).toBe('pine-extension-weather-report')
      expect(pkg.scripts.validate).toContain('pine-extension validate dist/weather-report')
      expect(pkg.devDependencies['@aurigax-ai/pine-extension-sdk']).toMatch(/^\^\d+\.\d+\.\d+$/)
      expect(readFileSync(join(made, '.gitignore'), 'utf8')).toBe('node_modules\ndist\n')
      expect(readdirSync(join(made, 'src'))).toEqual(['main.ts'])
      const catalog = JSON.parse(readFileSync(join(made, 'locales/zh-Hant.json'), 'utf8'))
      expect(Object.keys(catalog.manifest)).toEqual(['description', 'commands.greet.argument'])
      expect(catalog.messages.greeting).toBe('你好，{name}')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  it('refuses an id the loader would refuse and a folder that already holds files', () => {
    const template = join(sdkPackage, 'template')
    expect(runSdkCli(['create', 'Bad Id'], template)).toEqual({
      code: 1,
      lines: [
        'Bad Id: an id is 2 to 40 lowercase letters, digits or dashes, starting with a letter',
      ],
    })
    const taken = runSdkCli(['create', 'again', project], template)
    expect(taken).toEqual({ code: 1, lines: [`${project}: already exists and is not empty`] })
    expect(JSON.parse(readFileSync(join(project, 'pine.json'), 'utf8')).id).toBe('hello')
    expect(runSdkCli(['create'], template)).toEqual({ code: 2, lines: [SDK_CLI_USAGE] })
  })

  it('typechecks the template against the published types', () => {
    const tsc = join(repoRoot, 'node_modules/typescript/bin/tsc')
    const res = spawnSync(process.execPath, [tsc, '--noEmit', '-p', project], { encoding: 'utf8' })
    expect(res.stdout + res.stderr).toBe('')
    expect(res.status).toBe(0)
  }, 60_000)

  it('validates the built extension with the packaged command', () => {
    const res = spawnSync(process.execPath, [sdkCli, 'validate', built], { encoding: 'utf8' })
    expect(res.stdout.trim()).toBe('ok: extension hello 0.1.0')
    expect(res.status).toBe(0)
  })

  it('reports a broken manifest, a linked file, a bad catalog and a bad marketplace entry', () => {
    const broken = join(project, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, 'pine.json'), JSON.stringify({ id: 'broken' }))
    expect(runSdkCli(['validate', broken])).toEqual({ code: 1, lines: ['pine.json: missing name'] })

    const linked = join(project, 'linked')
    cpSync(built, linked, { recursive: true })
    symlinkSync('/etc/hostname', join(linked, 'host'))
    expect(runSdkCli(['validate', linked])).toEqual({
      code: 1,
      lines: ['pine.json: holds a link or special file, which a marketplace install refuses'],
    })

    const mistranslated = join(project, 'mistranslated')
    cpSync(built, mistranslated, { recursive: true })
    writeFileSync(
      join(mistranslated, 'locales/zh-Hant.json'),
      JSON.stringify({ manifest: { name: '哈囉', 'commands.wipe.title': '清除' } }),
    )
    expect(runSdkCli(['validate', mistranslated])).toEqual({
      code: 1,
      lines: [
        "pine.json: locales/zh-Hant.json: manifest.commands.wipe.title: not a string this extension's manifest declares",
      ],
    })
    rmSync(join(mistranslated, 'locales/zh-Hant.json'))
    expect(runSdkCli(['validate', mistranslated])).toEqual({
      code: 1,
      lines: ['pine.json: locales/zh-Hant.json: missing'],
    })

    const marketplace = join(project, 'marketplace')
    cpSync(built, join(marketplace, 'extensions/hello'), { recursive: true })
    cpSync(broken, join(marketplace, 'extensions/broken'), { recursive: true })
    const list = (extensions: string[]): void =>
      writeFileSync(
        join(marketplace, MARKETPLACE_MANIFEST_FILE),
        JSON.stringify({ name: 'Mine', extensions }),
      )
    list(['extensions/hello', 'extensions/broken', 'extensions/missing'])
    expect(runSdkCli(['validate', marketplace])).toEqual({
      code: 1,
      lines: [
        'extensions/broken: missing name',
        'extensions/missing: not a folder in the repository',
      ],
    })
    list(['extensions/hello'])
    expect(runSdkCli(['validate', marketplace])).toEqual({
      code: 0,
      lines: ['ok: marketplace "Mine" with 1 extension(s)'],
    })
    expect(runSdkCli(['publish'])).toEqual({ code: 2, lines: [SDK_CLI_USAGE] })
  })

  it('unlists an extension with a generated install code that the loader accepts', () => {
    const marketplace = join(project, 'unlisting')
    cpSync(built, join(marketplace, 'extensions/hello'), { recursive: true })
    const file = join(marketplace, MARKETPLACE_MANIFEST_FILE)
    writeFileSync(file, JSON.stringify({ name: 'Mine', extensions: ['extensions/hello'] }))

    expect(runSdkCli(['unlist', 'extensions/other', marketplace]).code).toBe(1)
    const res = runSdkCli(['unlist', 'extensions/hello', marketplace])
    const written = JSON.parse(readFileSync(file, 'utf8'))
    const code = written.unlisted[0].code
    expect(code).toMatch(MARKETPLACE_CODE_PATTERN)
    expect(written).toEqual({
      name: 'Mine',
      extensions: [],
      unlisted: [{ path: 'extensions/hello', code }],
    })
    expect(res).toEqual({
      code: 0,
      lines: [`unlisted extensions/hello: its install code is ${code}`],
    })
    expect(marketplaceManifestSchema.safeParse(written).success).toBe(true)
    expect(runSdkCli(['unlist', 'extensions/hello', marketplace])).toEqual({
      code: 0,
      lines: [`extensions/hello is already unlisted: its install code is ${code}`],
    })
    expect(runSdkCli(['validate', marketplace])).toEqual({
      code: 0,
      lines: ['ok: marketplace "Mine" with 0 extension(s), 1 unlisted'],
    })
    expect(newInstallCode()).not.toBe(newInstallCode())
  })

  it('runs the built extension in the extension host and answers its command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-sdk-host-'))
    const socketPath = join(dir, 'control.sock')
    const notify = vi.fn()
    let language = 'en'
    const host = new ExtensionHost({
      locale: () => language,
      roots: [{ dir: join(project, 'dist'), builtin: true }],
      store: new ExtensionStore(join(dir, 'extensions.json')),
      socketPath: () => socketPath,
      nodePath: process.execPath,
      workDirForWorkspace: () => undefined,
      broadcast: () => {},
      openPanelIn: () => {},
      notify,
      readyTimeoutMs: 8000,
      requestTimeoutMs: 4000,
      log: () => {},
    })
    registerExtensionMethods(() => host)
    registerControlServer(
      {
        execCommand: async () => ({ ok: true, result: null }) as CommandResult,
        listCommandsFor: () => [],
        getTerminalState: () => undefined,
      },
      socketPath,
    )
    const caller: ExtensionCaller = { kind: 'user', workspaceId: 's1', capabilities: [] }
    try {
      expect(await host.invoke('hello', 'greet', { argv: ['you'] }, caller)).toMatchObject({
        ok: true,
        text: 'Hello, you',
        data: { name: 'you' },
      })
      expect(notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Hello', body: 'Hello, you' }),
      )
      expect(await host.invoke('hello', 'greet', { argv: [] }, caller)).toMatchObject({
        ok: false,
        error: 'invalid-args',
        message: 'greet <name>',
      })
      expect(
        await host.invoke('hello', 'greet', { argv: ['you'] }, { ...caller, locale: 'zh-Hant' }),
      ).toMatchObject({ ok: true, text: '你好，you' })
      expect(notify).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: '哈囉', body: '你好，you' }),
      )
      const title = (): string | undefined =>
        host.list().find((e) => e.id === 'hello')?.commands[0].title
      expect(title()).toBe('Hello: Greet')
      language = 'zh-Hant'
      expect(title()).toBe('哈囉：打招呼')
    } finally {
      host.stopAll()
      stopControlServer()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
