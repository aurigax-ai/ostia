import { copyFileSync, cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

const { id } = JSON.parse(readFileSync('pine.json', 'utf8'))
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
copyFileSync('pine.json', join(out, 'pine.json'))
cpSync('locales', join(out, 'locales'), { recursive: true })
cpSync('skills', join(out, 'skills'), { recursive: true })
console.log(`built ${out}`)
