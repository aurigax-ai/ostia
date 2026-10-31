import { readFileSync } from 'node:fs'
import { build } from 'esbuild'

const rawPlugin = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({
      path: new URL(args.path.replace(/\?raw$/, ''), `file://${args.resolveDir}/`).pathname,
      namespace: 'raw',
    }))
    b.onLoad({ filter: /.*/, namespace: 'raw' }, (args) => ({
      contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
      loader: 'js',
    }))
  },
}

export async function buildNode(outdir) {
  await build({
    entryPoints: { 'ostia-node': 'src/node/runner.ts', 'ostia-cli': 'src/cli/index.ts' },
    outdir,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    plugins: [rawPlugin],
  })
}

if (import.meta.url === `file://${process.argv[1]}`) await buildNode(process.argv[2] ?? 'out/node')
