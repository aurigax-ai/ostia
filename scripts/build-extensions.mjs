import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { writeFigSpecs } from './completionSpecs.mjs'

const srcRoot = 'src/extensions'
const outRoot = 'out/extensions'
const assets = ['pine.json', 'panel.html', 'panel.css']

rmSync(outRoot, { recursive: true, force: true })

const ids = readdirSync(srcRoot).filter(
  (name) => name !== 'sdk' && statSync(join(srcRoot, name)).isDirectory(),
)

for (const id of ids) {
  const src = join(srcRoot, id)
  const out = join(outRoot, id)
  mkdirSync(out, { recursive: true })
  for (const file of assets) {
    if (existsSync(join(src, file))) copyFileSync(join(src, file), join(out, file))
  }
  if (existsSync(join(src, 'panel.html'))) copyFileSync(join(srcRoot, 'sdk/panel.css'), join(out, 'base.css'))
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

console.log(`built ${ids.length} extension(s): ${ids.join(', ')}`)
