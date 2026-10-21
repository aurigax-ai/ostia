import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PreviewTheme } from '../../shared/artifacts/htmlPreview'
import { PORTABLE_CSP } from '../../shared/artifacts/portable'
import { failedDocument, missingRuntimePackages, PortableBuilder } from './portableBuilder'
import type { Bundler } from './portableBundle'
import type { PreviewSource } from './previewFiles'

const runtimeDir = join(process.cwd(), 'out', 'artifact-runtime')
const LIGHT: PreviewTheme = {
  dark: false,
  vars: { '--ostia-bg': '#ffffff', '--ostia-fg': '#111111' },
}
const DARK: PreviewTheme = {
  dark: true,
  vars: { '--ostia-bg': '#101014', '--ostia-fg': '#eeeeee' },
}

const esbuild = (): Promise<Bundler> => import('esbuild') as unknown as Promise<Bundler>

function counting(): { load: () => Promise<Bundler>; builds: () => number } {
  let builds = 0
  return {
    load: async () => {
      const real = await esbuild()
      return {
        context: (options) => {
          builds += 1
          return real.context(options)
        },
      }
    },
    builds: () => builds,
  }
}

function builder(
  load: () => Promise<Bundler> = esbuild,
  timeoutMs?: number,
  cacheBytes?: number,
): PortableBuilder {
  return new PortableBuilder({
    load,
    runtimeDir: () => runtimeDir,
    version: '9.9.9',
    timeoutMs,
    cacheBytes,
  })
}

const made: string[] = []

function folder(files: Record<string, string | Buffer>): string {
  const dir = mkdtempSync(join(tmpdir(), 'portable-'))
  made.push(dir)
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  return dir
}

function artifact(dir: string, entry: string): PreviewSource {
  return { file: join(dir, entry), root: dir }
}

function srcdoc(file: string): string {
  const raw = /srcdoc="([^"]*)"/.exec(file)?.[1] ?? ''
  return raw.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

function manifestOf(file: string): Record<string, unknown> {
  const raw = /<script type="application\/json" id="ostia-artifact">([^<]*)<\/script>/.exec(
    file,
  )?.[1]
  return JSON.parse(raw ?? '{}')
}

function messages(built: Awaited<ReturnType<PortableBuilder['build']>>): string {
  return built.ok
    ? ''
    : built.problems.map((p) => `${p.file}:${p.line}:${p.column}: ${p.message}`).join('\n')
}

afterEach(() => {
  made.length = 0
})

const COUNTER = `import { useState } from 'react'
export default function App() {
  const [n, setN] = useState(0)
  return <button className="p-4" onClick={() => setN(n + 1)}>{n}</button>
}
`

describe('PortableBuilder', () => {
  it('PRT-C3 refuses an import that is a symlink out of the artifact folder', async () => {
    const outside = folder({ 'Chart.tsx': 'export default () => null\n' })
    const dir = folder({
      'App.tsx': "import Chart from './Chart.tsx'\nexport default () => <Chart />\n",
    })
    symlinkSync(join(outside, 'Chart.tsx'), join(dir, 'Chart.tsx'))
    const built = await builder().build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(built.ok).toBe(false)
    expect(messages(built)).toMatch(/Chart\.tsx.*not-found/)
  })

  it('PRT-C8 keeps the sources, libraries, theme and the document hash in the manifest', async () => {
    const dir = folder({
      'App.tsx':
        "import rows from './data.json'\nimport Chart from './Chart.tsx'\nexport default () => <Chart rows={rows} />\n",
      'Chart.tsx':
        'export default ({ rows }) => <ul>{rows.map((r) => <li key={r}>{r}</li>)}</ul>\n',
      'data.json': '["a","b"]\n',
    })
    const built = await builder().build(artifact(dir, 'App.tsx'), DARK, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const manifest = manifestOf(built.file)
    expect(manifest.format).toBe('ostia-artifact/1')
    expect(manifest.type).toBe('component')
    expect(manifest.ostia).toBe('9.9.9')
    expect(manifest.theme).toEqual(DARK)
    expect(Object.keys(manifest.sources as object).sort()).toEqual([
      'App.tsx',
      'Chart.tsx',
      'data.json',
    ])
    expect((manifest.sources as Record<string, string>)['data.json']).toBe('["a","b"]\n')
    expect(manifest.libraries).toContain('react@18.3.1')
    const document = srcdoc(built.file)
    expect(document).toBe(built.document)
    expect(manifest.hash).toBe(createHash('sha256').update(document).digest('hex'))
  })

  it('PRT-C9 inlines an imported image as a data URL and leaves it out of the sources', async () => {
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), randomBytes(200 * 1024)])
    const dir = folder({
      'App.jsx': "import photo from './photo.png'\nexport default () => <img src={photo} />\n",
      'photo.png': png,
    })
    const built = await builder().build(artifact(dir, 'App.jsx'), LIGHT, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.document).toContain('data:image/png;base64,')
    expect(Object.keys(manifestOf(built.file).sources as object)).toEqual(['App.jsx'])
  })

  it('PRT-C83 imports a .sqlite, .sqlite3 or .db file as bytes with sql.js and no node module', async () => {
    const seed = Buffer.concat([Buffer.from('SQLite format 3\0'), randomBytes(200 * 1024)])
    const dir = folder({
      'App.jsx':
        "import initSqlJs from 'sql.js'\nimport a from './a.sqlite'\nimport b from './b.sqlite3'\nimport c from './c.db'\nexport default () => <button onClick={() => initSqlJs().then((SQL) => new SQL.Database(a))}>{a.length + b.length + c.length}</button>\n",
      'a.sqlite': seed,
      'b.sqlite3': seed,
      'c.db': seed,
    })
    const built = await builder().build(artifact(dir, 'App.jsx'), LIGHT, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.document).toContain(seed.toString('base64').slice(0, 24))
    expect(built.document).not.toContain('node:fs')
    expect(built.document).not.toContain('WebAssembly.instantiate')
    expect(manifestOf(built.file).libraries).toEqual(
      expect.arrayContaining([expect.stringMatching(/^sql\.js@/)]),
    )
    expect(Object.keys(manifestOf(built.file).sources as object)).toEqual(['App.jsx'])
  })

  it('PRT-C84 refuses a database over 8 MiB and names the limit', async () => {
    const dir = folder({
      'App.jsx': "import seed from './big.sqlite'\nexport default () => <i>{seed.length}</i>\n",
      'big.sqlite': randomBytes(9 * 1024 * 1024),
    })
    const built = await builder().build(artifact(dir, 'App.jsx'), LIGHT, 'production')
    expect(built.ok).toBe(false)
    expect(messages(built)).toContain('big.sqlite:1:1: is over 8 MiB, the most a database may be')
  })

  it('PRT-C85 rebuilds when an imported database changes', async () => {
    const dir = folder({
      'App.jsx': "import seed from './data.sqlite'\nexport default () => <i>{seed.length}</i>\n",
      'data.sqlite': Buffer.from('one'),
    })
    const counter = counting()
    const b = builder(counter.load)
    const first = await b.build(artifact(dir, 'App.jsx'), LIGHT, 'development')
    const builds = counter.builds()
    writeFileSync(join(dir, 'data.sqlite'), Buffer.from('three!'))
    const changed = await b.build(artifact(dir, 'App.jsx'), LIGHT, 'development')
    expect(counter.builds()).toBeGreaterThan(builds)
    expect(first.ok && changed.ok && changed.document !== first.document).toBe(true)
  })

  it('PRT-C10 keeps only the icons a component imports', async () => {
    const dir = folder({
      'App.tsx': "import { Check } from 'lucide-react'\nexport default () => <Check />\n",
    })
    const built = await builder().build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.document).toContain('M20 6 9 17l-5-5')
    expect(built.document).not.toContain('M18 6 6 18')
    expect(Buffer.byteLength(built.file)).toBeLessThan(200 * 1024)
  })

  it('PRT-C11 names an import that is not bundled and lists the libraries', async () => {
    const dir = folder({
      'App.tsx': "import _ from 'lodash'\nexport default () => <p>{_.VERSION}</p>\n",
      'page.html':
        '<!doctype html><script type="module">\nimport { LineChart } from \'/runtime/recharts.js\'\n</script>\n',
    })
    for (const [entry, specifier] of [
      ['App.tsx', 'lodash'],
      ['page.html', '/runtime/recharts.js'],
    ]) {
      const built = await builder().build(artifact(dir, entry), LIGHT, 'development')
      expect(built.ok, entry).toBe(false)
      const text = messages(built)
      expect(text).toMatch(
        new RegExp(`:\\d+:\\d+: cannot import "${specifier.replace(/[/.]/g, '\\$&')}"`),
      )
      expect(text).toContain('recharts, lucide-react')
      if (!built.ok) expect(failedDocument(built.problems, LIGHT)).toContain(specifier)
    }
  })

  it('PRT-C12 reports a syntax error with file, line, column and message', async () => {
    const dir = folder({ 'App.tsx': 'export default function App() {\n  return <div>\n}\n' })
    const built = await builder().build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.problems[0].file).toBe('App.tsx')
    expect(built.problems[0].line).toBe(3)
    expect(built.problems[0].column).toBeGreaterThan(0)
    expect(built.problems[0].message.length).toBeGreaterThan(3)
  })

  it('PRT-C13 inlines a page’s scripts, stylesheets and assets and never changes the file', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'
    const page = `<!doctype html>
<html><head><link rel="stylesheet" href="./style.css"></head>
<body><img src="./logo.svg" alt="logo">
<script type="module">import { scaleLinear } from 'd3'\ndocument.body.dataset.v = scaleLinear()(1)</script>
<script src="./app.js"></script></body></html>
`
    const dir = folder({
      'page.html': page,
      'style.css': 'body { background: url(./bg.png) }\n',
      'bg.png': Buffer.from('89504e470d0a1a0a00', 'hex'),
      'logo.svg': svg,
      'app.js': 'window.ran = true\n',
    })
    const built = await builder().build(artifact(dir, 'page.html'), LIGHT, 'production')
    expect(built.ok, messages(built)).toBe(true)
    if (!built.ok) return
    expect(built.document).not.toMatch(/src="\.\/|href="\.\/style/)
    expect(built.document).toContain('data:image/svg+xml;base64,')
    expect(built.document).toContain('data:image/png;base64,')
    expect(built.document).toContain('window.ran = true')
    expect(built.document).not.toContain("from 'd3'")
    expect(built.document).toContain('<img alt="logo"'.slice(0, 4))
    expect(readFileSync(join(dir, 'page.html'), 'utf8')).toBe(page)
  })

  it('PRT-C15 bundles only the libraries for a file outside an artifact folder', async () => {
    const dir = folder({
      'x.tsx':
        "import Y from './y.tsx'\nimport { useState } from 'react'\nexport default () => <Y />\n",
      'y.tsx': 'export default () => null\n',
    })
    const outside = { file: join(dir, 'x.tsx'), root: null }
    const built = await builder().build(outside, LIGHT, 'development')
    expect(messages(built)).toMatch(/y\.tsx.*not-found/)
    const alone = folder({ 'z.tsx': COUNTER })
    const libraries = await builder().build(
      { file: join(alone, 'z.tsx'), root: null },
      LIGHT,
      'development',
    )
    expect(libraries.ok, messages(libraries)).toBe(true)
  })

  it('PRT-C16 compiles the Tailwind classes into a style before any script', async () => {
    const dir = folder({
      'App.tsx': 'export default () => <div className="p-4 bg-blue-500 dark:bg-zinc-900">x</div>\n',
    })
    const built = await builder().build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const style = built.document.indexOf('.p-4')
    expect(style).toBeGreaterThan(0)
    expect(built.document).toContain('.bg-blue-500')
    expect(built.document).toMatch(/dark\\:bg-zinc-900/)
    expect(style).toBeLessThan(built.document.indexOf('<script type="module">'))
    expect(built.document).not.toMatch(/@tailwindcss\/browser|tailwind\.js/)
  })

  it('PRT-C17 makes no rule for a class built from pieces and still builds', async () => {
    const dir = folder({
      'App.tsx': "export default ({ tone = 'red' }) => <div className={`bg-${tone}-500`}>x</div>\n",
    })
    const built = await builder().build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(built.ok, messages(built)).toBe(true)
    if (built.ok) expect(built.document).not.toContain('.bg-red-500')
  })

  it('PRT-C18 bakes the dark theme into the document', async () => {
    const dir = folder({ 'App.tsx': COUNTER })
    const built = await builder().build(artifact(dir, 'App.tsx'), DARK, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    expect(built.document).toMatch(/<html class="dark">/)
    expect(built.document).toContain('color-scheme:dark;--ostia-bg:#101014;--ostia-fg:#eeeeee')
  })

  it('PRT-C19 builds each theme on its own and keeps both in the cache', async () => {
    const dir = folder({ 'App.tsx': COUNTER })
    const counter = counting()
    const b = builder(counter.load)
    const light = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    const dark = await b.build(artifact(dir, 'App.tsx'), DARK, 'development')
    expect(light.ok && dark.ok).toBe(true)
    if (!light.ok || !dark.ok) return
    expect(dark.document).not.toBe(light.document)
    const builds = counter.builds()
    await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    await b.build(artifact(dir, 'App.tsx'), DARK, 'development')
    expect(counter.builds()).toBe(builds)
  })

  it('PRT-C20 previews with the development build and saves the smaller production build', async () => {
    const dir = folder({
      'App.tsx':
        "import { LineChart, Line } from 'recharts'\nexport default function App() {\n  throw new Error('render failed')\n  return <LineChart width={10} height={10} data={[]}><Line dataKey=\"y\" /></LineChart>\n}\n",
    })
    const b = builder()
    const preview = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    const saved = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(preview.ok && saved.ok).toBe(true)
    if (!preview.ok || !saved.ok) return
    expect(preview.document).toContain('The above error occurred in')
    expect(preview.document).toContain('componentStack')
    expect(saved.document).not.toContain('The above error occurred in')
    expect(Buffer.byteLength(preview.file) - Buffer.byteLength(saved.file)).toBeGreaterThan(
      500 * 1024,
    )
  })

  it('PRT-C24 names a runtime package the built tree does not have', () => {
    const tree = folder({ 'node_modules/react/package.json': '{"name":"react"}' })
    expect(missingRuntimePackages(tree, ['react', 'not-a-package'])).toEqual(['not-a-package'])
    expect(missingRuntimePackages(runtimeDir)).toEqual([])
  })

  it('PRT-C25 refuses a file over 16 MiB and names the limit and the largest inputs', async () => {
    const dir = folder({
      'App.jsx':
        "import big from './big.png'\nimport small from './small.png'\nexport default () => <><img src={big} /><img src={small} /></>\n",
      'big.png': randomBytes(13 * 1024 * 1024),
      'small.png': randomBytes(1024),
    })
    const built = await builder().build(artifact(dir, 'App.jsx'), LIGHT, 'production')
    expect(built.ok).toBe(false)
    const text = messages(built)
    expect(text).toContain('16 MiB')
    expect(text).toMatch(/big\.png \(13\.0 MiB\).*small\.png/)
  })

  it('PRT-C26 cancels a build that takes over its time and lets the next one run', async () => {
    let cancelled = 0
    let disposed = 0
    let stopped = 0
    const real = await esbuild()
    const load = async (): Promise<Bundler> => ({
      context: async (options) => {
        const slow = JSON.stringify(options.entryPoints).includes('ostia-shell') && hanging
        if (!slow) return real.context(options)
        let fail: (error: Error) => void = () => {}
        return {
          rebuild: () =>
            new Promise((_resolve, reject) => {
              fail = reject
            }),
          cancel: async () => {
            cancelled += 1
            fail(new Error('cancelled'))
          },
          dispose: async () => {
            disposed += 1
          },
        }
      },
      stop: () => {
        stopped += 1
      },
    })
    let hanging = true
    const dir = folder({ 'App.tsx': COUNTER })
    const b = builder(load, 50)
    const first = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    expect(messages(first)).toContain('took over 10 seconds to build')
    expect(cancelled).toBe(1)
    expect(disposed).toBe(1)
    expect(stopped).toBe(0)
    hanging = false
    const next = await builder(load).build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    expect(next.ok, messages(next)).toBe(true)
  })

  it('PRT-C67 cancels only the build that timed out, never one running beside it', async () => {
    const real = await esbuild()
    let cancelled = 0
    const slowLoad = async (): Promise<Bundler> => ({
      context: async (options) => {
        const ctx = await real.context(options)
        return {
          rebuild: () => new Promise(() => {}),
          cancel: async () => {
            cancelled += 1
            await ctx.cancel()
          },
          dispose: () => ctx.dispose(),
        }
      },
      stop: () => real.stop?.(),
    })
    const slowDir = folder({ 'Slow.tsx': COUNTER })
    const fastDir = folder({
      'Fast.tsx':
        "import { LineChart } from 'recharts'\nexport default () => <LineChart width={1} height={1} data={[]} />\n",
    })
    const fast = builder(esbuild, 30_000).build(artifact(fastDir, 'Fast.tsx'), LIGHT, 'development')
    const slow = await builder(slowLoad, 100).build(
      artifact(slowDir, 'Slow.tsx'),
      LIGHT,
      'development',
    )
    expect(messages(slow)).toContain('took over 10 seconds to build')
    expect(cancelled).toBe(1)
    const fastBuilt = await fast
    expect(fastBuilt.ok, messages(fastBuilt)).toBe(true)
  })

  it('PRT-C71 keeps the cache under its byte cap, with one copy of each build', async () => {
    const b = builder(esbuild, undefined, 1024 * 1024)
    for (let i = 0; i < 6; i += 1) {
      const dir = folder({
        'App.jsx': "import big from './big.txt'\nexport default () => <p>{big.length}</p>\n",
        'big.txt': `${i}`.repeat(300 * 1024),
      })
      const built = await b.build(artifact(dir, 'App.jsx'), LIGHT, 'production')
      expect(built.ok, messages(built)).toBe(true)
      if (built.ok)
        expect(Object.getOwnPropertyDescriptor(built, 'file')?.get).toBeTypeOf('function')
    }
    expect(b.cachedBytes()).toBeLessThanOrEqual(1024 * 1024)
    expect(b.cachedBytes()).toBeGreaterThan(0)
  })

  it('PRT-C27 serves an unchanged build from the cache and rebuilds when an import changes', async () => {
    const dir = folder({
      'App.tsx': "import label from './label.ts'\nexport default () => <p>{label}</p>\n",
      'label.ts': "export default 'one'\n",
    })
    const counter = counting()
    const b = builder(counter.load)
    const first = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    const builds = counter.builds()
    const again = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    expect(counter.builds()).toBe(builds)
    expect(again).toBe(first)
    writeFileSync(join(dir, 'label.ts'), "export default 'two'\n")
    const changed = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    expect(counter.builds()).toBeGreaterThan(builds)
    expect(changed.ok && changed.document.includes('two')).toBe(true)
  })

  it('PRT-C39 never hands out the cached development build for a save', async () => {
    const dir = folder({ 'App.tsx': COUNTER })
    const counter = counting()
    const b = builder(counter.load)
    const preview = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'development')
    const builds = counter.builds()
    const saved = await b.build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(counter.builds()).toBeGreaterThan(builds)
    expect(preview.ok && saved.ok).toBe(true)
    if (preview.ok && saved.ok) expect(saved.document).not.toBe(preview.document)
  })

  it('PRT-C21 starts the file with the portable policy and no eval', async () => {
    const dir = folder({ 'App.tsx': COUNTER })
    const built = await builder().build(artifact(dir, 'App.tsx'), LIGHT, 'production')
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const first = /<meta http-equiv="([^"]+)" content="([^"]+)">/.exec(built.file)
    expect(first?.[1]).toBe('Content-Security-Policy')
    expect(first?.[2].replace(/&#39;|&apos;/g, "'")).toBe(PORTABLE_CSP)
    expect(built.file.indexOf('http-equiv')).toBeLessThan(built.file.indexOf('<script'))
    expect(PORTABLE_CSP).not.toMatch(/unsafe-eval|wasm-unsafe-eval/)
  })
})
