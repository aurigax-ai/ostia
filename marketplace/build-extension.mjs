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

const manifestFiles = ['ostia.json']
const assets = [...manifestFiles, 'panel.html', 'panel.css']
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
  if (!existsSync(list)) return { packages: {}, closures: {} }
  const { packages = {}, closures = {} } = JSON.parse(readFileSync(list, 'utf8'))
  return { packages, closures }
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

function copyVendoredPackages(src, out) {
  const { packages, closures } = vendoredPackages(src)
  for (const [name, target] of Object.entries(packages)) {
    copyPackage(installedPackage(name), join(out, target))
  }
  for (const [name, target] of Object.entries(closures)) {
    for (const [dependency, from] of dependencyClosure(installedPackage(name))) {
      copyPackage(from, join(out, target, dependency))
    }
  }
}

function readSourceManifest(src) {
  const file = manifestFiles.find((name) => existsSync(join(src, name))) ?? manifestFiles[0]
  return JSON.parse(readFileSync(join(src, file), 'utf8'))
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

export async function buildExtension(src, out, panelBaseCss) {
  mkdirSync(out, { recursive: true })
  for (const file of assets) {
    if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file))
  }
  for (const dir of copiedDirs) {
    if (existsSync(join(src, dir))) cpSync(join(src, dir), join(out, dir), { recursive: true })
  }
  copyVendoredPackages(src, out)
  copyAgentSkills(src, out)
  await buildFileKinds(src, out, panelBaseCss)
  if (existsSync(join(src, 'panel.html'))) copyFileSync(panelBaseCss, join(out, 'base.css'))
  if (existsSync(join(src, 'main.ts'))) {
    await build({
      entryPoints: [join(src, 'main.ts')],
      outfile: join(out, 'main.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'warning',
    })
  }
  if (existsSync(join(src, 'panel.ts'))) {
    await browserBundle(join(src, 'panel.ts'), join(out, 'panel.js'))
  }
}
