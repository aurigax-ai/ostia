import { readFileSync } from 'node:fs'

const QUERY = '?dataurl'

export function fontDataUrl() {
  return {
    name: 'pine-font-data-url',
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
      const bytes = readFileSync(id.slice(0, -QUERY.length))
      return `export default ${JSON.stringify(`data:font/woff2;base64,${bytes.toString('base64')}`)}`
    },
  }
}
