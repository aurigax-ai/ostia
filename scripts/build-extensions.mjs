import { readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { buildExtension } from '../marketplace/build-extension.mjs'
import { writeFigSpecs } from './completionSpecs.mjs'
import { marketplaceIds } from './marketplace.mjs'

const srcRoot = 'src/extensions'
const builtinRoot = 'out/extensions'
const published = marketplaceIds()
const panelBaseCss = join(srcRoot, 'sdk/panel.css')

async function writeCatalog(exportName, file) {
  const bundle = resolve(builtinRoot, 'dict-build.mjs')
  await build({
    entryPoints: ['src/shared/app/dict.ts'],
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
  const out = join(builtinRoot, id)
  await buildExtension(join(srcRoot, id), out, panelBaseCss)
  if (id === 'completions') await writeFigSpecs(join(out, 'specs'))
  if (id === 'langpack-zh-hant') await writeCatalog('zhHant', join(out, 'zh-Hant.json'))
}

console.log(`built ${ids.length} built-in extension(s): ${ids.join(', ')}`)
