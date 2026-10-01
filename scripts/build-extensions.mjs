import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { copyBundledSources } from './bundled-sources.mjs'
import { writeFigSpecs } from './completionSpecs.mjs'

const srcRoot = 'src/extensions'
const builtinRoot = 'out/extensions'
const marketplaceRoot = 'out/marketplace'
const marketplaceIds = [
  'keeper',
  'lsp-bash',
  'lsp-clangd',
  'lsp-gopls',
  'lsp-lua',
  'lsp-marksman',
  'lsp-pyright',
  'lsp-rust-analyzer',
  'lsp-typescript',
  'lsp-yaml',
  'model-runtime',
  'trellis',
]
const marketplaceManifest = {
  name: 'Pine extensions',
  description: 'Extensions for Pine that are not built in',
  extensions: marketplaceIds.map((id) => `extensions/${id}`),
}
const assets = ['pine.json', 'panel.html', 'panel.css']
const localesDir = 'locales'

async function writeCatalog(exportName, file) {
  const bundle = resolve(builtinRoot, 'dict-build.mjs')
  await build({
    entryPoints: ['src/renderer/i18n/dict.ts'],
    outfile: bundle,
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
  })
  const dict = await import(pathToFileURL(bundle).href)
  rmSync(bundle)
  writeFileSync(file, `${JSON.stringify(dict[exportName], null, 2)}\n`)
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
  const list = join(src, 'vendor.json')
  if (!existsSync(list)) return
  const { packages = {}, closures = {} } = JSON.parse(readFileSync(list, 'utf8'))
  for (const [name, target] of Object.entries(packages)) {
    copyPackage(realpathSync(join('node_modules', name)), join(out, target))
  }
  for (const [name, target] of Object.entries(closures)) {
    for (const [dependency, from] of dependencyClosure(join('node_modules', name))) {
      copyPackage(from, join(out, target, dependency))
    }
  }
}

rmSync(builtinRoot, { recursive: true, force: true })
rmSync(marketplaceRoot, { recursive: true, force: true })

const ids = readdirSync(srcRoot).filter(
  (name) => name !== 'sdk' && statSync(join(srcRoot, name)).isDirectory(),
)

const marketplaceBuilds = []

for (const id of ids) {
  const src = join(srcRoot, id)
  const out = marketplaceIds.includes(id)
    ? join(marketplaceRoot, 'extensions', id)
    : join(builtinRoot, id)
  mkdirSync(out, { recursive: true })
  for (const file of assets) {
    if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file))
  }
  if (existsSync(join(src, localesDir))) {
    cpSync(join(src, localesDir), join(out, localesDir), { recursive: true })
  }
  copyVendoredPackages(src, out)
  if (existsSync(join(src, 'panel.html')))
    copyFileSync(join(srcRoot, 'sdk/panel.css'), join(out, 'base.css'))
  if (existsSync(join(src, 'main.ts'))) {
    const result = await build({
      metafile: true,
      entryPoints: [join(src, 'main.ts')],
      outfile: join(out, 'main.js'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      logLevel: 'warning',
    })
    if (marketplaceIds.includes(id)) marketplaceBuilds.push(result)
  }
  if (existsSync(join(src, 'panel.ts'))) {
    const result = await build({
      metafile: true,
      entryPoints: [join(src, 'panel.ts')],
      outfile: join(out, 'panel.js'),
      bundle: true,
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      loader: { '.svg': 'text' },
      logLevel: 'warning',
    })
    if (marketplaceIds.includes(id)) marketplaceBuilds.push(result)
  }
  if (id === 'completions') await writeFigSpecs(join(out, 'specs'))
  if (id === 'langpack-zh-hant') await writeCatalog('zhHant', join(out, 'zh-Hant.json'))
}

copyBundledSources(marketplaceBuilds, marketplaceRoot)

writeFileSync(
  join(marketplaceRoot, 'pine-marketplace.json'),
  `${JSON.stringify(marketplaceManifest, null, 2)}\n`,
)

const builtinIds = ids.filter((id) => !marketplaceIds.includes(id))
console.log(`built ${builtinIds.length} built-in extension(s): ${builtinIds.join(', ')}`)
console.log(`built ${marketplaceIds.length} marketplace extension(s): ${marketplaceIds.join(', ')}`)
