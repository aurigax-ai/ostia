import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { build } from 'esbuild'

const QUERY = '?pagescript'

export function pageScriptPlugin() {
  return {
    name: 'page-script',
    configureVitest({ defineCacheKeyGenerator }) {
      defineCacheKeyGenerator(({ id }) => (id.endsWith(QUERY) ? false : undefined))
    },
    async load(id) {
      if (!id.endsWith(QUERY)) return null
      const file = id.slice(0, -QUERY.length)
      const result = await build({
        stdin: {
          contents: await readFile(file, 'utf8'),
          resolveDir: dirname(file),
          sourcefile: file,
          loader: 'ts',
        },
        bundle: true,
        write: false,
        format: 'iife',
        platform: 'browser',
        target: 'es2022',
        tsconfigRaw: '{}',
        legalComments: 'none',
        metafile: true,
        logLevel: 'silent',
      })
      this.addWatchFile(file)
      for (const input of Object.keys(result.metafile.inputs)) {
        if (input !== '<stdin>') this.addWatchFile(resolve(input))
      }
      return `export default ${JSON.stringify(result.outputFiles[0].text)}`
    },
  }
}
