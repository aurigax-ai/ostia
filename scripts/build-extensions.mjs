import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { writeFigSpecs } from './completionSpecs.mjs'
import { marketplaceIds } from './marketplace.mjs'

const srcRoot = 'src/extensions'
const builtinRoot = 'out/extensions'
const published = marketplaceIds()
const assets = ['pine.json', 'panel.html', 'panel.css']

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

rmSync(builtinRoot, { recursive: true, force: true })

const ids = readdirSync(srcRoot).filter(
  (name) =>
    name !== 'sdk' && !published.includes(name) && statSync(join(srcRoot, name)).isDirectory(),
)

for (const id of ids) {
  const src = join(srcRoot, id)
  const out = join(builtinRoot, id)
  mkdirSync(out, { recursive: true })
  for (const file of assets) {
    if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file))
  }
  if (existsSync(join(src, 'panel.html')))
    copyFileSync(join(srcRoot, 'sdk/panel.css'), join(out, 'base.css'))
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
  if (id === 'completions') await writeFigSpecs(join(out, 'specs'))
  if (id === 'langpack-zh-hant') await writeCatalog('zhHant', join(out, 'zh-Hant.json'))
}

console.log(`built ${ids.length} built-in extension(s): ${ids.join(', ')}`)
