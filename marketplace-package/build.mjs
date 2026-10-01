import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const sources = 'src/extensions'
const installed = 'extensions'

rmSync(installed, { recursive: true, force: true })

for (const id of readdirSync(sources).sort()) {
  const out = join(installed, id)
  mkdirSync(out, { recursive: true })
  copyFileSync(join(sources, id, 'pine.json'), join(out, 'pine.json'))
  await build({
    entryPoints: [join(sources, id, 'main.ts')],
    outfile: join(out, 'main.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'warning',
  })
  console.log(`built ${out}`)
}
