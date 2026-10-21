import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from '../contract/extensionApi'
import { parseManifest } from './extensionManifest'
import { extensionManifestSchema, marketplaceManifestSchema } from './manifestSchema'
import { MARKETPLACE_CODE_PATTERN, MARKETPLACE_MANIFEST_FILE } from './marketplaceManifest'
import { newInstallCode, runSdkCli, SDK_CLI_USAGE } from './sdkCli'

const packageDir = resolve(__dirname, '../..')
const sdkPackage = resolve(packageDir, '../../out/sdk')
const sdkCli = join(sdkPackage, 'dist/cli.cjs')
const templateManifest = join(packageDir, 'template/ostia.json')

describe('manifest schemas', () => {
  it('accept the template manifest', () => {
    const res = extensionManifestSchema.safeParse(
      JSON.parse(readFileSync(templateManifest, 'utf8')),
    )
    expect(res.success ? null : res.error.message).toBeNull()
  })

  it('refuse what the loader refuses', () => {
    const base = { id: 'demo', name: 'Demo', version: '1.0.0', api: '7.0' }
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
      ...[
        [],
        [{ kind: 'Bad', title: 'T', fields: {} }],
        [{ kind: 'http', title: '', fields: {} }],
        [{ kind: 'http', title: 'T', fields: { n: { title: 'N', type: 'number' } } }],
        [{ kind: 'http', title: 'T', fields: { a: { title: 'A', type: 'enum' } } }],
        [{ kind: 'http', title: 'T', fields: { a: { title: 'A', type: 'string', enum: ['x'] } } }],
        [
          {
            kind: 'http',
            title: 'T',
            fields: { a: { title: 'A', type: 'enum', enum: ['x'], default: 'y' } },
          },
        ],
        [
          {
            kind: 'http',
            title: 'T',
            fields: { a: { title: 'A', type: 'string' } },
            secrets: { a: { title: 'A' } },
          },
        ],
        [
          { kind: 'http', title: 'T', fields: {} },
          { kind: 'http', title: 'U', fields: {} },
        ],
      ].map((connections) => ({ ...base, contributes: { connections } })),
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
          { url: 'https://github.com.evil.example/t.gz' },
          { url: 'https://objectsXgithubusercontent.com/t.gz' },
          { url: 'https://release-assets.githubusercontentXcom/t.gz' },
          { url: 'https://github.com@evil.example/t.gz' },
          { url: 'https://evil.example/https://github.com/t.gz' },
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
      readFileSync(join(sdkPackage, 'schemas/ostia.schema.json'), 'utf8'),
    ) as { required: string[]; properties: Record<string, { enum?: string[] }> }
    expect(schema.required).toEqual(['id', 'name', 'version', 'api'])
    expect(schema.properties.category?.enum).toContain('scm')
  })
})

describe('extension API version', () => {
  it('is bumped whenever the published contract changes', () => {
    const built = JSON.parse(readFileSync(join(sdkPackage, 'api.json'), 'utf8'))
    const lock = JSON.parse(readFileSync(join(packageDir, 'api-lock.json'), 'utf8'))
    expect(lock.version, 'run pnpm api:bump <minor|major>').toBe(EXTENSION_API_VERSION)
    expect(
      built.digest,
      'the SDK types or manifest schemas changed: run pnpm api:bump <minor|major>',
    ).toBe(lock.digest)
  })

  it('SCX-C21 locks the workspace.closed event and ext.sandboxDomains in the published contract', () => {
    const lock = JSON.parse(readFileSync(join(packageDir, 'api-lock.json'), 'utf8'))
    const built = JSON.parse(readFileSync(join(sdkPackage, 'api.json'), 'utf8'))
    expect(built).toEqual(lock)
    expect(lock.version).toBe(EXTENSION_API_VERSION)
    const shared = readFileSync(join(sdkPackage, 'types/contract/extensions.d.ts'), 'utf8')
    const sdk = readFileSync(join(sdkPackage, 'types/client/index.d.ts'), 'utf8')
    expect(shared).toContain("'workspace.closed': {")
    expect(sdk).toContain('sandboxDomains: (workspaceId: string) => Promise<SandboxDomainsResult>')
  })

  it('ships the TypeScript it was built from, unchanged', () => {
    for (const file of [
      'src/client/index.ts',
      'src/assist/service.ts',
      'src/contract/extensions.ts',
      'src/manifest/extensionManifest.ts',
      'src/manifest/manifestSchema.ts',
    ]) {
      expect(readFileSync(join(sdkPackage, file), 'utf8'), file).toBe(
        readFileSync(join(packageDir, file), 'utf8'),
      )
    }
  })

  it('is what the template declares', () => {
    expect(JSON.parse(readFileSync(templateManifest, 'utf8')).api).toBe(EXTENSION_API_VERSION)
  })

  it('is published in the package for authors and tools', () => {
    const pkg = JSON.parse(readFileSync(join(sdkPackage, 'package.json'), 'utf8'))
    expect(pkg.ostiaExtensionApi).toBe(EXTENSION_API_VERSION)
  })

  it('is published as @aurigax-ai/ostia-extension-sdk', () => {
    const pkg = JSON.parse(readFileSync(join(sdkPackage, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('@aurigax-ai/ostia-extension-sdk')
    expect(pkg.repository.url).toBe('git+https://github.com/aurigax-ai/ostia.git')
  })

  it('declares the ostia-extension command in the form npm keeps', () => {
    const pkg = JSON.parse(readFileSync(join(sdkPackage, 'package.json'), 'utf8'))
    expect(pkg.bin).toEqual({ 'ostia-extension': 'dist/cli.cjs' })
    expect(existsSync(join(sdkPackage, pkg.bin['ostia-extension']))).toBe(true)
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
    project = mkdtempSync(join(tmpdir(), 'ostia-sdk-consumer-'))
    execFileSync(process.execPath, [sdkCli, 'create', 'hello', project], { stdio: 'ignore' })
    linkDependency('@aurigax-ai/ostia-extension-sdk', sdkPackage)
    for (const name of ['esbuild', '@types/node']) {
      linkDependency(name, join(packageDir, 'node_modules', name))
    }
    execFileSync(process.execPath, ['build.mjs'], { cwd: project, stdio: 'ignore' })
    built = join(project, 'dist/hello')
  }, 60_000)

  afterAll(() => {
    rmSync(project, { recursive: true, force: true })
  })

  it('creates a project named after the id, ready for git and for the build', () => {
    const parent = mkdtempSync(join(tmpdir(), 'ostia-sdk-create-'))
    try {
      const res = spawnSync(process.execPath, [sdkCli, 'create', 'weather-report'], {
        cwd: parent,
        encoding: 'utf8',
      })
      expect(res.status).toBe(0)
      expect(res.stdout).toContain('created the Weather Report extension in weather-report')
      const made = join(parent, 'weather-report')
      const manifest = JSON.parse(readFileSync(join(made, 'ostia.json'), 'utf8'))
      expect(parseManifest(manifest, made).ok).toBe(true)
      expect(manifest).toMatchObject({ id: 'weather-report', name: 'Weather Report' })
      expect(manifest.contributes.commands[0]).toMatchObject({
        title: 'Weather Report: Greet',
        category: 'Weather Report',
      })
      const pkg = JSON.parse(readFileSync(join(made, 'package.json'), 'utf8'))
      expect(pkg.name).toBe('ostia-extension-weather-report')
      expect(pkg.scripts.validate).toContain('ostia-extension validate dist/weather-report')
      expect(pkg.devDependencies['@aurigax-ai/ostia-extension-sdk']).toMatch(
        /^\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/,
      )
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
    expect(JSON.parse(readFileSync(join(project, 'ostia.json'), 'utf8')).id).toBe('hello')
    expect(runSdkCli(['create'], template)).toEqual({ code: 2, lines: [SDK_CLI_USAGE] })
  })

  it('typechecks the template against the published types', () => {
    const tsc = join(packageDir, 'node_modules/typescript/bin/tsc')
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
    writeFileSync(join(broken, 'ostia.json'), JSON.stringify({ id: 'broken' }))
    expect(runSdkCli(['validate', broken])).toEqual({
      code: 1,
      lines: ['ostia.json: missing name'],
    })

    const linked = join(project, 'linked')
    cpSync(built, linked, { recursive: true })
    symlinkSync('/etc/hostname', join(linked, 'host'))
    expect(runSdkCli(['validate', linked])).toEqual({
      code: 1,
      lines: ['ostia.json: holds a link or special file, which a marketplace install refuses'],
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
        "ostia.json: locales/zh-Hant.json: manifest.commands.wipe.title: not a string this extension's manifest declares",
      ],
    })
    rmSync(join(mistranslated, 'locales/zh-Hant.json'))
    expect(runSdkCli(['validate', mistranslated])).toEqual({
      code: 1,
      lines: ['ostia.json: locales/zh-Hant.json: missing'],
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
})
