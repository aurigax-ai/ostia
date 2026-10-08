import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

export const marketplaceProject = 'marketplace'

export function marketplaceIds() {
  const manifest = JSON.parse(
    readFileSync(join(marketplaceProject, 'ostia-marketplace.json'), 'utf8'),
  )
  const folders = [...manifest.extensions, ...(manifest.unlisted ?? []).map((entry) => entry.path)]
  return folders.map((folder) => basename(folder))
}
