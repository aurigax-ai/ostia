import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { RUNTIME_MODULES, TAILWIND_PACKAGE } from '../../shared/artifacts/artifactRuntime'

const DARK_BY_CLASS = '@custom-variant dark (&:where(.dark, .dark *));'
const AT_IMPORT = '@import'
const WITH_PREFLIGHT = `${AT_IMPORT} "${TAILWIND_PACKAGE}";\n${DARK_BY_CLASS}`
const WITHOUT_PREFLIGHT = [
  `${AT_IMPORT} "${TAILWIND_PACKAGE}/theme.css" layer(theme);`,
  `${AT_IMPORT} "${TAILWIND_PACKAGE}/utilities.css" layer(utilities);`,
  DARK_BY_CLASS,
].join('\n')
const CANDIDATE = /[^\s"'`<>={};\\]+/g

const COMPILE_IN_WORKER = `
const { parentPort, workerData } = require('node:worker_threads')
const { createRequire } = require('node:module')
const { readFile } = require('node:fs/promises')
const { dirname, join, resolve } = require('node:path')
const { runtimeDir, tree, packageName, css, candidates, dropEmpty } = workerData
const packageDir = join(tree, packageName)
const tailwind = createRequire(join(runtimeDir, 'package.json'))(packageName)
const options = {
  base: packageDir,
  loadStylesheet: async (id, base) => {
    const path = id.startsWith(packageName)
      ? join(tree, id === packageName ? packageName + '/index.css' : id)
      : resolve(base, id)
    if (!path.startsWith(packageDir + '/')) throw new Error('no stylesheet ' + id)
    return { path, base: dirname(path), content: await readFile(path, 'utf8') }
  },
}
;(async () => {
  const out = (await tailwind.compile(css, options)).build(candidates)
  const empty = dropEmpty ? (await tailwind.compile(css, options)).build([]) : null
  parentPort.postMessage(out === empty ? '' : out)
})().catch((error) => parentPort.postMessage({ error: String(error && error.message || error) }))
`

export type TailwindStyle = 'component' | 'page'

function classCandidates(texts: Iterable<string>): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const match of text.matchAll(CANDIDATE)) found.add(match[0])
  }
  return [...found]
}

export class PortableTailwind {
  constructor(private readonly runtimeDir: () => string) {}

  css(style: TailwindStyle, texts: Iterable<string>, signal?: AbortSignal): Promise<string> {
    const runtimeDir = this.runtimeDir()
    const worker = new Worker(COMPILE_IN_WORKER, {
      eval: true,
      workerData: {
        runtimeDir,
        tree: join(runtimeDir, RUNTIME_MODULES),
        packageName: TAILWIND_PACKAGE,
        css: style === 'component' ? WITH_PREFLIGHT : WITHOUT_PREFLIGHT,
        candidates: classCandidates(texts),
        dropEmpty: style === 'page',
      },
    })
    return new Promise<string>((resolve, reject) => {
      const stop = (): void => {
        void worker.terminate()
        reject(new Error('the Tailwind compile was stopped'))
      }
      if (signal?.aborted) {
        stop()
        return
      }
      signal?.addEventListener('abort', stop, { once: true })
      worker.once('message', (message: string | { error: string }) => {
        signal?.removeEventListener('abort', stop)
        void worker.terminate()
        if (typeof message === 'string') resolve(message)
        else reject(new Error(message.error))
      })
      worker.once('error', (error) => {
        signal?.removeEventListener('abort', stop)
        reject(error)
      })
    })
  }
}
