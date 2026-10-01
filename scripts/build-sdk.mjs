import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { apiVersion, contractDigest } from './api-contract.mjs'
import { copyBundledSources } from './bundled-sources.mjs'

const out = 'out/sdk'
const sdk = 'src/extensions/sdk'
const assets = 'sdk-package'
const packageName = '@aurigax-ai/pine-extension-sdk'
const repository = 'https://github.com/aurigax-ai/pine-extension-sdk'
const app = JSON.parse(readFileSync('package.json', 'utf8'))
const versionOf = (name) => app.dependencies[name] ?? app.devDependencies[name]
const assistPeers = ['ai', 'zod', '@ai-sdk-tool/parser', 'undici']

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'schemas'), { recursive: true })

const library = await build({
  metafile: true,
  entryPoints: {
    index: join(sdk, 'index.ts'),
    assist: join(sdk, 'assist/index.ts'),
    panel: join(sdk, 'panel.ts'),
    splitter: join(sdk, 'splitter.ts'),
  },
  outdir: join(out, 'dist'),
  bundle: true,
  splitting: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  logLevel: 'warning',
})

const cli = await build({
  metafile: true,
  entryPoints: ['src/cli/sdkCliEntry.ts'],
  outfile: join(out, 'dist/cli.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
})

execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.sdk.json'], { stdio: 'inherit' })

const schemaModule = resolve(out, 'schema-build.mjs')
const schema = await build({
  metafile: true,
  entryPoints: ['src/cli/manifestSchema.ts'],
  outfile: schemaModule,
  bundle: true,
  platform: 'node',
  format: 'esm',
  logLevel: 'warning',
})
const { jsonSchemas } = await import(pathToFileURL(schemaModule).href)
const schemas = jsonSchemas()
rmSync(schemaModule)
const writeJson = (file, value) =>
  writeFileSync(join(out, file), `${JSON.stringify(value, null, 2)}\n`)
writeJson('schemas/pine.schema.json', schemas.extension)
writeJson('schemas/pine-marketplace.schema.json', schemas.marketplace)

writeJson('api.json', { version: apiVersion(), digest: contractDigest(out) })

copyBundledSources([library, cli, schema], out)
cpSync(join(sdk, 'panel.css'), join(out, 'panel.css'))
cpSync(join(assets, 'README.md'), join(out, 'README.md'))
cpSync(join(assets, 'template'), join(out, 'template'), { recursive: true })
mkdirSync(join(out, 'docs'))
cpSync('docs/EXTENSIONS.md', join(out, 'docs/EXTENSIONS.md'))

const types = (entry) => `./types/extensions/sdk/${entry}.d.ts`
writeJson('package.json', {
  name: packageName,
  version: app.version,
  description: 'SDK for writing Pine extensions',
  pineExtensionApi: apiVersion(),
  license: app.license,
  repository: { type: 'git', url: `git+${repository}.git` },
  type: 'module',
  engines: { node: '>=20' },
  bin: { 'pine-extension': './dist/cli.cjs' },
  types: types('index'),
  exports: {
    '.': { types: types('index'), default: './dist/index.js' },
    './assist': { types: types('assist/index'), default: './dist/assist.js' },
    './panel': { types: types('panel'), default: './dist/panel.js' },
    './splitter': { types: types('splitter'), default: './dist/splitter.js' },
    './panel.css': './panel.css',
    './schemas/pine.schema.json': './schemas/pine.schema.json',
    './schemas/pine-marketplace.schema.json': './schemas/pine-marketplace.schema.json',
    './api.json': './api.json',
    './package.json': './package.json',
  },
  dependencies: { 'vscode-jsonrpc': versionOf('vscode-jsonrpc') },
  peerDependencies: Object.fromEntries(assistPeers.map((name) => [name, versionOf(name)])),
  peerDependenciesMeta: Object.fromEntries(assistPeers.map((name) => [name, { optional: true }])),
})

console.log(`built ${packageName} ${app.version} in ${out}`)
