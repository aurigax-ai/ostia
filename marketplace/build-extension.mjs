import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { build } from 'esbuild'

const manifestFile = 'ostia.json'
const assets = [manifestFile, 'panel.html', 'panel.css']
const copiedDirs = ['locales', 'assets']
const vendorList = 'vendor.json'
const skillEntry = 'SKILL.md'

export function installedPackage(name) {
  let dir = resolve('.')
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`${name} is not installed`)
    dir = parent
  }
}

export function vendoredPackages(src) {
  const list = join(src, vendorList)
  if (!existsSync(list)) return { packages: {}, closures: {}, files: {} }
  const { packages = {}, closures = {}, files = {} } = JSON.parse(readFileSync(list, 'utf8'))
  return { packages, closures, files }
}

function packageFile(spec) {
  const parts = spec.split('/')
  const name = parts.slice(0, spec.startsWith('@') ? 2 : 1).join('/')
  return join(installedPackage(name), ...parts.slice(name.split('/').length))
}

function copyVendoredFiles(src, out) {
  for (const [spec, target] of Object.entries(vendoredPackages(src).files)) {
    cpSync(packageFile(spec), join(out, target), { recursive: true, dereference: true })
  }
}

function withoutNestedModules(from) {
  return (path) => !path.slice(from.length).split(/[\\/]/).includes('node_modules')
}

function copyPackage(from, to) {
  cpSync(from, to, { recursive: true, dereference: true, filter: withoutNestedModules(from) })
}

function dependencyClosure(dir, found = new Map()) {
  const real = realpathSync(dir)
  const manifest = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8'))
  const known = found.get(manifest.name)
  if (known) {
    if (known !== real) throw new Error(`two versions of ${manifest.name} in one server`)
    return found
  }
  found.set(manifest.name, real)
  const marker = `${sep}node_modules${sep}`
  const modules = real.slice(0, real.lastIndexOf(marker) + marker.length)
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    dependencyClosure(join(modules, name), found)
  }
  return found
}

function modulesOf(dir) {
  const marker = `${sep}node_modules${sep}`
  return dir.slice(0, dir.lastIndexOf(marker) + marker.length)
}

function installedOptionals(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  return Object.keys(manifest.optionalDependencies ?? {})
    .map((name) => [name, join(modulesOf(dir), name)])
    .filter(([, from]) => existsSync(join(from, 'package.json')))
}

function modulesTarget(name, target) {
  const folder = join(target)
  const suffix = join('node_modules', name)
  if (folder !== suffix && !folder.endsWith(`${sep}${suffix}`)) return null
  return folder.slice(0, folder.length - name.length)
}

export function requiredPackages(src) {
  const { packages } = vendoredPackages(src)
  return Object.entries(packages)
    .filter(([name, target]) => join(target) === join('node_modules', name))
    .flatMap(([name]) => [name, `${name}/*`])
}

function copyVendoredPackages(src, out) {
  const { packages, closures } = vendoredPackages(src)
  for (const [name, target] of Object.entries(packages)) {
    const from = installedPackage(name)
    copyPackage(from, join(out, target))
    const modules = modulesTarget(name, target)
    if (modules === null) continue
    for (const [optional, dir] of installedOptionals(from)) {
      copyPackage(realpathSync(dir), join(out, modules, optional))
    }
  }
  for (const [name, target] of Object.entries(closures)) {
    for (const [dependency, from] of dependencyClosure(installedPackage(name))) {
      copyPackage(from, join(out, target, dependency))
    }
  }
}

function readSourceManifest(src) {
  return JSON.parse(readFileSync(join(src, manifestFile), 'utf8'))
}

function copyAgentSkills(src, out) {
  const manifest = readSourceManifest(src)
  for (const skill of manifest.contributes?.agentSkills ?? []) {
    mkdirSync(join(out, skill.path), { recursive: true })
    for (const file of [skillEntry, ...(skill.files ?? [])]) {
      copyFileSync(join(src, skill.path, file), join(out, skill.path, file))
    }
  }
}

function bundleAliases(src) {
  const file = join(src, 'bundle.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).alias ?? {}) : {}
}

function browserBundle(entry, outfile, alias = {}) {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    loader: { '.svg': 'text' },
    alias,
    logLevel: 'warning',
  })
}

function nodeBundle(entry, outfile, src) {
  return build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: requiredPackages(src),
    logLevel: 'warning',
  })
}

async function buildFileKinds(src, out, panelBaseCss) {
  const kinds = (readSourceManifest(src).contributes?.fileKinds ?? []).filter((kind) => kind.view)
  if (kinds.length === 0) return
  const alias = bundleAliases(src)
  copyFileSync(panelBaseCss, join(out, 'base.css'))
  for (const {
    view: { entry },
  } of kinds) {
    copyFileSync(join(src, entry), join(out, entry))
    const script = entry.replace(/\.html$/, '.ts')
    if (existsSync(join(src, script))) {
      await browserBundle(join(src, script), join(out, script.replace(/\.ts$/, '.js')), alias)
    }
  }
  for (const name of readdirSync(src).filter((file) => file.endsWith('.worker.ts'))) {
    await browserBundle(join(src, name), join(out, name.replace(/\.ts$/, '.js')), alias)
  }
}

const wasmFiles = [
  ['quickjs-wasi', 'quickjs.wasm'],
  ['@silvia-odwyer/photon-node', 'photon_rs_bg.wasm'],
]

function siblingPackage(from, name) {
  let dir = from
  for (;;) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function copyWasm(out) {
  const owner = installedPackage('@earendil-works/pi-coding-agent')
  for (const [name, file] of wasmFiles) {
    const dir = siblingPackage(owner, name)
    if (!dir || !existsSync(join(dir, file)))
      throw new Error(`missing ${name}/${file} for ${owner}`)
    copyFileSync(join(dir, file), join(out, file))
  }
}

async function bundleModuleMain(src, out) {
  await build({
    entryPoints: [join(src, 'main.ts')],
    outdir: out,
    bundle: true,
    splitting: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outExtension: { '.js': '.mjs' },
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: 'warning',
  })
  copyWasm(out)
}

async function bundleMain(src, out) {
  if (readSourceManifest(src).main?.endsWith('.mjs')) {
    await bundleModuleMain(src, out)
    return
  }
  const threads = readdirSync(src).filter((file) => file.endsWith('.thread.ts'))
  for (const entry of ['main.ts', ...threads]) {
    await nodeBundle(join(src, entry), join(out, entry.replace(/\.ts$/, '.js')), src)
  }
}

export async function buildExtension(src, out, panelBaseCss) {
  mkdirSync(out, { recursive: true })
  for (const file of assets) {
    if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file))
  }
  for (const dir of copiedDirs) {
    if (existsSync(join(src, dir))) cpSync(join(src, dir), join(out, dir), { recursive: true })
  }
  copyVendoredPackages(src, out)
  copyVendoredFiles(src, out)
  copyAgentSkills(src, out)
  await buildFileKinds(src, out, panelBaseCss)
  if (existsSync(join(src, 'panel.html'))) copyFileSync(panelBaseCss, join(out, 'base.css'))
  if (existsSync(join(src, 'main.ts'))) await bundleMain(src, out)
  if (existsSync(join(src, 'panel.ts'))) {
    await browserBundle(join(src, 'panel.ts'), join(out, 'panel.js'))
  }
}
