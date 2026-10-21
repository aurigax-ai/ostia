import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'out', 'artifact-runtime')
const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE']
const DROPPED = [
  /\.map$/,
  /\.d\.[cm]?ts$/,
  /\.tsbuildinfo$/,
  /^(README|CHANGELOG|HISTORY)(\.\w+)?$/i,
]

async function runtimeList() {
  const result = await build({
    entryPoints: [join(root, 'src', 'shared', 'artifacts', 'artifactRuntime.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
  })
  const source = Buffer.from(result.outputFiles[0].contents).toString('base64')
  return import(`data:text/javascript;base64,${source}`)
}

function readPackage(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

function packageDir(name, from) {
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`${name} is not installed for ${from}`)
    dir = parent
  }
}

function installedDependencies(dir) {
  const info = readPackage(dir)
  const wanted = {
    ...info.dependencies,
    ...info.optionalDependencies,
    ...info.peerDependencies,
  }
  const found = []
  for (const name of Object.keys(wanted)) {
    try {
      found.push([name, packageDir(name, dir)])
    } catch {
      if (info.dependencies?.[name]) throw new Error(`${info.name} needs ${name}, not installed`)
    }
  }
  return found
}

function kept(source) {
  const name = basename(source)
  return name !== 'node_modules' && !DROPPED.some((pattern) => pattern.test(name))
}

function place(name, source, parent, placed) {
  const top = join(outDir, 'node_modules', name)
  const existing = placed.get(top)
  if (existing === source) return
  const target = existing === undefined ? top : join(parent, 'node_modules', name)
  if (placed.get(target) === source) return
  placed.set(target, source)
  cpSync(source, target, { recursive: true, filter: kept, dereference: true })
  for (const [dependency, dir] of installedDependencies(source)) {
    place(dependency, dir, target, placed)
  }
}

function notice(dir) {
  const info = readPackage(dir)
  const file = LICENSE_NAMES.map((candidate) => join(dir, candidate)).find(existsSync)
  const text = file ? readFileSync(file, 'utf8').trim() : `License: ${info.license ?? 'unknown'}`
  return `${info.name} ${info.version}\n${'-'.repeat(40)}\n${text}\n`
}

async function usedFiles(specifiers) {
  const used = new Set()
  for (const mode of ['development', 'production']) {
    const result = await build({
      stdin: {
        contents: specifiers
          .map((s, i) => `export * as m${i} from ${JSON.stringify(s)}`)
          .join('\n'),
        resolveDir: outDir,
        loader: 'js',
      },
      bundle: true,
      write: false,
      metafile: true,
      absWorkingDir: outDir,
      format: 'esm',
      platform: 'browser',
      external: ['node:*'],
      define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
      logLevel: 'error',
    })
    for (const input of Object.keys(result.metafile.inputs)) used.add(resolve(outDir, input))
  }
  return used
}

function prune(dir, used, keepAll) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (keepAll.some((kept) => path === kept)) continue
      prune(path, used, keepAll)
      if (readdirSync(path).length === 0) rmSync(path, { recursive: true })
    } else if (
      !used.has(path) &&
      entry.name !== 'package.json' &&
      !LICENSE_NAMES.includes(entry.name)
    ) {
      rmSync(path)
    }
  }
}

const { RUNTIME_NOTICES, TAILWIND_PACKAGE, importableSpecifiers, runtimeEntry, runtimePackages } =
  await runtimeList()

rmSync(outDir, { recursive: true, force: true })
mkdirSync(join(outDir, 'node_modules'), { recursive: true })

const placed = new Map()
for (const name of runtimePackages()) place(name, packageDir(name, root), outDir, placed)

const sources = [...new Set(placed.values())].sort()
writeFileSync(join(outDir, RUNTIME_NOTICES), sources.map(notice).join('\n'))

const used = await usedFiles([...importableSpecifiers(), 'react/jsx-runtime'].map(runtimeEntry))
prune(join(outDir, 'node_modules'), used, [join(outDir, 'node_modules', TAILWIND_PACKAGE)])
