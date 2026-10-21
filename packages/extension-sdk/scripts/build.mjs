import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { parse } from 'yaml'
import { apiVersion, contractDigest, packageDir } from './api-contract.mjs'

const requireFromPackage = createRequire(join(packageDir, 'package.json'))
const inlineSvg = {
  name: 'inline-svg',
  setup(builder) {
    builder.onResolve({ filter: /\.svg$/ }, (args) => ({
      path: requireFromPackage.resolve(args.path),
    }))
    builder.onLoad({ filter: /\.svg$/ }, (args) => ({
      contents: readFileSync(args.path, 'utf8'),
      loader: 'text',
    }))
  },
}

const repoRoot = resolve(packageDir, '../..')
const out = join(repoRoot, 'out/sdk')
const repository = 'https://github.com/aurigax-ai/ostia'
const source = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const { catalog } = parse(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8'))
const ranges = (dependencies) =>
  Object.fromEntries(
    Object.entries(dependencies).map(([name, range]) => [
      name,
      range === 'catalog:' ? catalog[name] : range,
    ]),
  )
const bundleOptions = {
  absWorkingDir: packageDir,
  metafile: true,
  bundle: true,
  logLevel: 'warning',
}

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'schemas'), { recursive: true })

const library = await build({
  ...bundleOptions,
  entryPoints: {
    index: 'src/client/index.ts',
    assist: 'src/assist/index.ts',
    panel: 'src/client/panel.ts',
    splitter: 'src/client/splitter.ts',
    viewer: 'src/client/viewer.ts',
    grid: 'src/client/grid.ts',
    cells: 'src/client/cells.ts',
    pill: 'src/client/pill.ts',
    slider: 'src/client/slider.ts',
    atomicWrite: 'src/client/atomicWrite.ts',
  },
  outdir: join(out, 'dist'),
  splitting: true,
  packages: 'external',
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  plugins: [inlineSvg],
})

const cli = await build({
  ...bundleOptions,
  entryPoints: ['src/manifest/sdkCliEntry.ts'],
  outfile: join(out, 'dist/cli.cjs'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
})

execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.types.json'], {
  cwd: packageDir,
  stdio: 'inherit',
})

const schemaModule = join(out, 'schema-build.mjs')
const schema = await build({
  ...bundleOptions,
  entryPoints: ['src/manifest/manifestSchema.ts'],
  outfile: schemaModule,
  platform: 'node',
  format: 'esm',
})
const { jsonSchemas } = await import(pathToFileURL(schemaModule).href)
const schemas = jsonSchemas()
rmSync(schemaModule)
const writeJson = (file, value) =>
  writeFileSync(join(out, file), `${JSON.stringify(value, null, 2)}\n`)
writeJson('schemas/ostia.schema.json', schemas.extension)
writeJson('schemas/ostia-marketplace.schema.json', schemas.marketplace)

writeJson('api.json', { version: apiVersion(), digest: contractDigest(out) })

const inputs = new Set(
  [library, cli, schema].flatMap((result) => Object.keys(result.metafile.inputs)),
)
for (const path of [...inputs].filter((input) => input.startsWith('src/'))) {
  mkdirSync(dirname(join(out, path)), { recursive: true })
  cpSync(join(packageDir, path), join(out, path))
}
cpSync(join(packageDir, 'src/client/panel.css'), join(out, 'panel.css'))
for (const path of ['README.md', 'LICENSE', 'docs', 'template']) {
  cpSync(join(packageDir, path), join(out, path), { recursive: true })
}
const template = JSON.parse(readFileSync(join(packageDir, 'template/package.json'), 'utf8'))
writeJson('template/package.json', {
  ...template,
  devDependencies: { [source.name]: `^${version}`, ...template.devDependencies },
})

const types = (entry) => `./types/${entry}.d.ts`
writeJson('package.json', {
  name: source.name,
  version,
  description: source.description,
  keywords: source.keywords,
  ostiaExtensionApi: apiVersion(),
  license: source.license,
  homepage: `${repository}/tree/main/packages/extension-sdk#readme`,
  bugs: `${repository}/issues`,
  repository: { type: 'git', url: `git+${repository}.git`, directory: 'packages/extension-sdk' },
  publishConfig: { access: 'public' },
  type: 'module',
  engines: { node: '>=20' },
  bin: { 'ostia-extension': 'dist/cli.cjs' },
  types: types('client/index'),
  exports: {
    '.': { types: types('client/index'), default: './dist/index.js' },
    './assist': { types: types('assist/index'), default: './dist/assist.js' },
    './panel': { types: types('client/panel'), default: './dist/panel.js' },
    './splitter': { types: types('client/splitter'), default: './dist/splitter.js' },
    './viewer': { types: types('client/viewer'), default: './dist/viewer.js' },
    './grid': { types: types('client/grid'), default: './dist/grid.js' },
    './cells': { types: types('client/cells'), default: './dist/cells.js' },
    './pill': { types: types('client/pill'), default: './dist/pill.js' },
    './slider': { types: types('client/slider'), default: './dist/slider.js' },
    './atomicWrite': { types: types('client/atomicWrite'), default: './dist/atomicWrite.js' },
    './panel.css': './panel.css',
    './schemas/ostia.schema.json': './schemas/ostia.schema.json',
    './schemas/ostia-marketplace.schema.json': './schemas/ostia-marketplace.schema.json',
    './api.json': './api.json',
    './package.json': './package.json',
  },
  dependencies: ranges(source.dependencies),
  peerDependencies: ranges(source.peerDependencies),
  peerDependenciesMeta: source.peerDependenciesMeta,
})

console.log(`built ${source.name} ${version} in ${out}`)
