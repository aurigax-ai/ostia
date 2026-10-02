import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { build } from 'esbuild'

const assets = ['pine.json', 'panel.html', 'panel.css']
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

function copyAgentSkills(src, out) {
  const manifest = JSON.parse(readFileSync(join(src, 'pine.json'), 'utf8'))
  for (const skill of manifest.contributes?.agentSkills ?? []) {
    mkdirSync(join(out, skill.path), { recursive: true })
    for (const file of [skillEntry, ...(skill.files ?? [])]) {
      copyFileSync(join(src, skill.path, file), join(out, skill.path, file))
    }
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
    await build({
      entryPoints: [join(src, 'panel.ts')],
      outfile: join(out, 'panel.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      loader: { '.svg': 'text' },
      logLevel: 'warning',
    })
  }
}
