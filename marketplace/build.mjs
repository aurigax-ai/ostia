import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildExtension, installedPackage } from './build-extension.mjs'

const sources = 'src/extensions'
const installed = 'extensions'
const signature = 'ostia.sig'
const panelBaseCss = join(installedPackage('@aurigax-ai/ostia-extension-sdk'), 'panel.css')

const only = process.argv[2]
const ids = only ? [only] : readdirSync(sources).sort()

const signatures = new Map(
  ids
    .map((id) => [id, join(installed, id, signature)])
    .filter(([, file]) => existsSync(file))
    .map(([id, file]) => [id, readFileSync(file)]),
)

if (only) rmSync(join(installed, only), { recursive: true, force: true })
else rmSync(installed, { recursive: true, force: true })

for (const id of ids) {
  const out = join(installed, id)
  await buildExtension(join(sources, id), out, panelBaseCss)
  const kept = signatures.get(id)
  if (kept) writeFileSync(join(out, signature), kept)
  console.log(`built ${out}`)
}
