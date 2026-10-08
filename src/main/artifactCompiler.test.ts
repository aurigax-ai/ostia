import { describe, expect, it, vi } from 'vitest'
import {
  ArtifactCompiler,
  COMPILE_MAX_BYTES,
  type Transformer,
  compiles,
  reportingModule,
} from './artifactCompiler'

const real = async (): Promise<Transformer> => (await import('esbuild')) as unknown as Transformer

function compiler(load: () => Promise<Transformer> = real, timeoutMs?: number): ArtifactCompiler {
  return new ArtifactCompiler(load, 'chrome120', timeoutMs)
}

describe('ArtifactCompiler', () => {
  it('compiles .jsx, .tsx and .ts and nothing else', () => {
    expect(['a.tsx', 'a.jsx', 'a.ts', 'A.TSX'].map(compiles)).toEqual([true, true, true, true])
    expect(['a.js', 'a.html', 'a.mjs', 'tsx'].map(compiles)).toEqual([false, false, false, false])
  })

  it('turns a .tsx file into an ES module and leaves its imports for the page', async () => {
    const source = [
      "import { useState } from 'react'",
      "import { LineChart } from 'recharts'",
      "import Part from './Part'",
      'export default function App({ title }: { title?: string }) {',
      '  const [n, setN] = useState<number>(0)',
      '  return <button onClick={() => setN(n + 1)}>{title}{n}<Part /><LineChart /></button>',
      '}',
    ].join('\n')
    const code = await compiler().compile('App.tsx', Buffer.from(source))
    expect(code).toContain('from "react"')
    expect(code).toContain('from "recharts"')
    expect(code).toContain('from "./Part"')
    expect(code).toContain('from "react/jsx-runtime"')
    expect(code).toMatch(/export\s*\{\s*App as default\s*\}/)
    expect(code).not.toContain(': number')
    expect(code).toContain('sourceMappingURL=data:application/json;base64,')
    expect(code).not.toMatch(/\beval\(|new Function\(/)
  })

  it('serves a syntax error as a module that reports file, line and column', async () => {
    const code = await compiler().compile(
      'Broken.tsx',
      Buffer.from('export default function A() {\n  return <div>\n}\n'),
    )
    expect(code.startsWith('throw new Error(')).toBe(true)
    const text = JSON.parse(code.slice('throw new Error('.length, code.lastIndexOf(')'))) as string
    expect(text).toMatch(/^Broken\.tsx:3:\d+: /)
    expect(() => new Function(code)()).toThrow(/Broken\.tsx:3:/)
  })

  it('keeps hostile text in an error inside one string', () => {
    const code = reportingModule([
      { file: 'a.tsx', line: 1, column: 1, message: '")\nfetch("http://x")//' },
    ])
    expect(code.split('\n').filter(Boolean)).toHaveLength(1)
    expect(() => new Function(code)()).toThrow('fetch("http://x")')
  })

  it('refuses a source over 1 MiB without running the compiler', async () => {
    const transform = vi.fn()
    const code = await compiler(async () => ({ transform })).compile(
      'Big.tsx',
      Buffer.alloc(COMPILE_MAX_BYTES + 1, 0x20),
    )
    expect(code).toContain('Big.tsx:1:1: is over 1 MiB')
    expect(transform).not.toHaveBeenCalled()
  })

  it('gives up after its time and stops the compiler process', async () => {
    const stop = vi.fn()
    const code = await compiler(
      async () => ({ transform: () => new Promise(() => {}), stop }),
      30,
    ).compile('Slow.tsx', Buffer.from('export default 1'))
    expect(code).toContain('Slow.tsx:1:1: took over 5 seconds to compile')
    expect(stop).toHaveBeenCalledOnce()
  })

  it('compiles the same content once', async () => {
    const transform = vi.fn(async () => ({ code: 'export default 1\n' }))
    const c = compiler(async () => ({ transform }))
    await c.compile('A.tsx', Buffer.from('x'))
    await c.compile('B.tsx', Buffer.from('x'))
    await c.compile('A.tsx', Buffer.from('y'))
    expect(transform).toHaveBeenCalledTimes(2)
  })

  it('reports a missing compiler instead of throwing', async () => {
    const code = await compiler(async () => {
      throw new Error('Cannot find module esbuild')
    }).compile('A.tsx', Buffer.from('export default 1'))
    expect(code).toContain('A.tsx:1:1: the compiler is not available in this build')
  })
})
