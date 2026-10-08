import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out', 'artifact-runtime')
const require = createRequire(join(root, 'package.json'))
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const RESERVED = new Set(['default', '__esModule', 'module.exports'])
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE']

async function runtimeList() {
  const result = await build({
    entryPoints: [join(root, 'src', 'shared', 'artifactRuntime.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  return import(`data:text/javascript;base64,${source}`)
}

async function exportsOf(specifier) {
  const namespace = await import(specifier)
  const names = Object.keys(namespace).filter((name) => !RESERVED.has(name))
  const fromDefault =
    names.length === 0 && namespace.default && typeof namespace.default === 'object'
      ? Object.keys(namespace.default)
      : []
  return {
    names: [...new Set([...names, ...fromDefault])].filter((name) => IDENTIFIER.test(name)),
    hasDefault: 'default' in namespace,
  }
}

function entrySource(specifier, { names, hasDefault }) {
  const from = JSON.stringify(specifier)
  const lines = [`import * as library from ${from}`]
  lines.push('const source = library.default && !library.__esModule ? { ...library.default, ...library } : library')
  if (hasDefault) lines.push('export default library.default')
  if (names.length > 0) {
    lines.push(`const { ${names.map((name) => `${name}: $${name}`).join(', ')} } = source`)
    lines.push(`export { ${names.map((name) => `$${name} as ${name}`).join(', ')} }`)
  }
  return lines.join('\n')
}

function exactExternals(names) {
  return {
    name: 'exact-externals',
    setup(builder) {
      builder.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!names.includes(args.path)) return null
        if (args.kind !== 'require-call') return { path: args.path, external: true }
        return { path: args.path, namespace: 'required-external' }
      })
      builder.onLoad({ filter: /.*/, namespace: 'required-external' }, (args) => ({
        contents: `export * from ${JSON.stringify(args.path)}\nexport { default } from ${JSON.stringify(args.path)}`,
        resolveDir: root,
      }))
    },
  }
}

function packageDir(name) {
  let dir = dirname(require.resolve(name))
  while (!existsSync(join(dir, 'package.json')) || readPackage(dir).name !== name) {
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`package.json of ${name} not found`)
    dir = parent
  }
  return dir
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function notice(name) {
  const dir = packageDir(name)
  const info = readPackage(dir)
  const file = LICENSE_NAMES.map((candidate) => join(dir, candidate)).find(existsSync)
  const text = file ? readFileSync(file, 'utf8').trim() : `License: ${info.license ?? 'unknown'}`
  return `${info.name} ${info.version}\n${'-'.repeat(40)}\n${text}\n`
}

const { ARTIFACT_RUNTIME, TAILWIND_RUNTIME, RUNTIME_NOTICES } = await runtimeList()

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const module of ARTIFACT_RUNTIME) {
  await build({
    stdin: {
      contents: entrySource(module.specifier, await exportsOf(module.specifier)),
      resolveDir: root,
      loader: 'js',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    plugins: [exactExternals(module.external)],
    define: { 'process.env.NODE_ENV': '"development"' },
    legalComments: 'none',
    logLevel: 'error',
    outfile: join(outDir, module.file),
  })
}

copyFileSync(
  join(packageDir(TAILWIND_RUNTIME.package), 'dist', 'index.global.js'),
  join(outDir, TAILWIND_RUNTIME.file),
)

const packages = [...new Set([...ARTIFACT_RUNTIME.map((m) => m.package), TAILWIND_RUNTIME.package])]
writeFileSync(join(outDir, RUNTIME_NOTICES), packages.map(notice).join('\n'))
