import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
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
import { MARKETPLACE_MANIFEST_FILE } from '../shared/marketplace'
import type { CommandResult } from '../shared/types'
import { extensionManifestSchema, marketplaceManifestSchema } from './manifestSchema'
import { SDK_CLI_USAGE, runSdkCli } from './sdkCli'

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
    join(repoRoot, 'test/fixtures/extensions-lsp/fake-lang/pine.json'),
    join(repoRoot, 'test/fixtures/extensions-lsp/fake-json/pine.json'),
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
    const bad: Record<string, unknown>[] = [
      { ...base, id: 'Bad Id' },
      { ...base, name: '' },
      { ...base, category: 'games' },
      { ...base, capabilities: ['root'] },
      { ...base, contributes: { commands: [{ id: 'Run It', title: 'Run' }] } },
      { ...base, contributes: { assist: ['everything'] } },
      { ...base, contributes: { languages: [{ id: 'not a tag', label: 'X', path: 'x.json' }] } },
      { ...base, contributes: { languages: [{ id: 'fr', label: 'Français', path: 'fr.yaml' }] } },
      {
        ...base,
        contributes: { settings: { k: { type: 'color', default: '', description: 'd' } } },
      },
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
    ]
    for (const manifest of bad) {
      expect(parseManifest(manifest, '/ext').ok, JSON.stringify(manifest)).toBe(false)
      expect(extensionManifestSchema.safeParse(manifest).success, JSON.stringify(manifest)).toBe(
        false,
      )
    }
    expect(parseManifest(base, '/ext').ok).toBe(true)
    expect(extensionManifestSchema.safeParse(base).success).toBe(true)
  })

  it('describe a marketplace file', () => {
    expect(marketplaceManifestSchema.safeParse({ name: 'Mine', extensions: ['a'] }).success).toBe(
      true,
    )
    expect(marketplaceManifestSchema.safeParse({ extensions: ['a'] }).success).toBe(false)
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
    const marketplace = join(repoRoot, 'out/marketplace')
    for (const file of ['src/extensions/trellis/main.ts', 'src/extensions/sdk/index.ts']) {
      expect(readFileSync(join(marketplace, file), 'utf8'), file).toBe(
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
    cpSync(join(sdkPackage, 'template'), project, { recursive: true })
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

  it('reports a broken manifest, a linked file and a bad marketplace entry', () => {
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

  it('runs the built extension in the extension host and answers its command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pine-sdk-host-'))
    const socketPath = join(dir, 'control.sock')
    const notify = vi.fn()
    const host = new ExtensionHost({
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
      })
    } finally {
      host.stopAll()
      stopControlServer()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
