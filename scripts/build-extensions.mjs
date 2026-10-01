import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { writeFigSpecs } from './completionSpecs.mjs'

const srcRoot = 'src/extensions'
const builtinRoot = 'out/extensions'
const marketplaceRoot = 'out/marketplace'
const marketplaceIds = ['keeper', 'model-runtime', 'trellis']
const marketplaceManifest = {
  name: 'Pine extensions',
  description: 'Extensions for Pine that are not built in',
  extensions: marketplaceIds.map((id) => `extensions/${id}`),
}
const assets = ['pine.json', 'panel.html', 'panel.css']

rmSync(builtinRoot, { recursive: true, force: true })
rmSync(marketplaceRoot, { recursive: true, force: true })

const ids = readdirSync(srcRoot).filter(
  (name) => name !== 'sdk' && statSync(join(srcRoot, name)).isDirectory(),
)

for (const id of ids) {
  const src = join(srcRoot, id)
  const out = marketplaceIds.includes(id)
    ? join(marketplaceRoot, 'extensions', id)
    : join(builtinRoot, id)
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
}

writeFileSync(
  join(marketplaceRoot, 'pine-marketplace.json'),
  `${JSON.stringify(marketplaceManifest, null, 2)}\n`,
)

const builtinIds = ids.filter((id) => !marketplaceIds.includes(id))
console.log(`built ${builtinIds.length} built-in extension(s): ${builtinIds.join(', ')}`)
console.log(`built ${marketplaceIds.length} marketplace extension(s): ${marketplaceIds.join(', ')}`)
