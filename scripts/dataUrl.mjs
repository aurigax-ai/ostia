import { readFileSync } from 'node:fs'

const QUERY = '?dataurl'

const MIME_TYPES = { '.woff2': 'font/woff2', '.wasm': 'application/wasm' }

export function dataUrl() {
  return {
    name: 'ostia-data-url',
    enforce: 'pre',
    async resolveId(source, importer) {
      if (!source.endsWith(QUERY)) return null
      const resolved = await this.resolve(source.slice(0, -QUERY.length), importer, {
        skipSelf: true,
      })
      return resolved ? `${resolved.id}${QUERY}` : null
    },
    load(id) {
      if (!id.endsWith(QUERY)) return null
      const file = id.slice(0, -QUERY.length)
      const mime = MIME_TYPES[file.slice(file.lastIndexOf('.'))]
      if (!mime) throw new Error(`no data URL type for ${file}`)
      const bytes = readFileSync(file)
      return `export default ${JSON.stringify(`data:${mime};base64,${bytes.toString('base64')}`)}`
    },
  }
}
