import { readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildExtension, installedPackage } from './build-extension.mjs'

const sources = 'src/extensions'
const installed = 'extensions'
const panelBaseCss = join(installedPackage('@aurigax-ai/ostia-extension-sdk'), 'panel.css')

rmSync(installed, { recursive: true, force: true })

for (const id of readdirSync(sources).sort()) {
  const out = join(installed, id)
  await buildExtension(join(sources, id), out, panelBaseCss)
  console.log(`built ${out}`)
}
