import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const manifest = 'ostia.json'
const { id } = JSON.parse(readFileSync(manifest, 'utf8'))
const out = join('dist', id)

mkdirSync(out, { recursive: true })
await build({
  entryPoints: ['src/main.ts'],
  outfile: join(out, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
})
copyFileSync(manifest, join(out, manifest))
cpSync('locales', join(out, 'locales'), { recursive: true })
cpSync('skills', join(out, 'skills'), { recursive: true })
console.log(`built ${out}`)
