import { cpSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function copyBundledSources(results, outDir) {
  const inputs = new Set(results.flatMap((result) => Object.keys(result.metafile.inputs)))
  const sources = [...inputs].filter((path) => path.startsWith('src/')).sort()
  for (const path of sources) {
    const target = join(outDir, path)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(path, target)
  }
  return sources.length
}
